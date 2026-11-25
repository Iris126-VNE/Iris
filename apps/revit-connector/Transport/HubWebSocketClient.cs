using System.Diagnostics;
using System.IO;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using RevitMcpConnector.Core;

namespace RevitMcpConnector.Transport;

public sealed class HubWebSocketClient : IDisposable
{
    private readonly ConnectorSettings _settings;
    private readonly int _revitYear;
    private readonly ExternalEventDispatcher _dispatcher;
    private readonly CancellationTokenSource _cts = new();
    private readonly string _instanceId = $"revit-{Environment.MachineName.ToLowerInvariant()}-{Process.GetCurrentProcess().Id}";
    private ClientWebSocket? _ws;

    public HubWebSocketClient(ConnectorSettings settings, int revitYear, ExternalEventDispatcher dispatcher)
    {
        _settings = settings;
        _revitYear = revitYear;
        _dispatcher = dispatcher;
    }

    public void Start()
    {
        _ = Task.Run(() => RunLoopAsync(_cts.Token));
    }

    private async Task RunLoopAsync(CancellationToken ct)
    {
        var backoffMs = 2000;
        while (!ct.IsCancellationRequested)
        {
            try
            {
                using var ws = new ClientWebSocket();
                ws.Options.SetRequestHeader("Authorization", $"Bearer {_settings.ApiKey}");
                await ws.ConnectAsync(new Uri(_settings.HubWsUrl), ct);
                _ws = ws;
                backoffMs = 2000;

                var docs = await _dispatcher.SnapshotOpenDocumentsAsync(ct);
                await SendJsonAsync(ws, new
                {
                    type = "hello",
                    instanceId = _instanceId,
                    revitYear = _revitYear,
                    machineAlias = _settings.MachineAlias,
                    catalogVersion = "connector-v1",
                    supportedTools = _dispatcher.SupportedTools,
                    openDocuments = docs
                }, ct);

                using var hbCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
                var hbTask = HeartbeatLoopAsync(ws, hbCts.Token);

                await ReceiveLoopAsync(ws, ct);

                hbCts.Cancel();
                try { await hbTask; } catch { /* ignore */ }
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch
            {
                await Task.Delay(backoffMs, ct);
                backoffMs = Math.Min(backoffMs * 2, 30_000);
            }
            finally
            {
                _ws = null;
            }
        }
    }

    private async Task HeartbeatLoopAsync(ClientWebSocket ws, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested && ws.State == WebSocketState.Open)
        {
            await Task.Delay(15_000, ct);
            var docs = await _dispatcher.SnapshotOpenDocumentsAsync(ct);
            await SendJsonAsync(ws, new
            {
                type = "heartbeat",
                instanceId = _instanceId,
                timestampUtc = DateTime.UtcNow.ToString("O"),
                openDocuments = docs
            }, ct);
        }
    }

    private async Task ReceiveLoopAsync(ClientWebSocket ws, CancellationToken ct)
    {
        var buffer = new byte[64 * 1024];
        using var ms = new MemoryStream();

        while (ws.State == WebSocketState.Open && !ct.IsCancellationRequested)
        {
            ms.SetLength(0);
            WebSocketReceiveResult result;
            do
            {
                result = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), ct);
                if (result.MessageType == WebSocketMessageType.Close) return;
                ms.Write(buffer, 0, result.Count);
            }
            while (!result.EndOfMessage);

            var text = Encoding.UTF8.GetString(ms.ToArray());
            using var doc = JsonDocument.Parse(text);
            if (!doc.RootElement.TryGetProperty("type", out var typeProp)) continue;

            if (typeProp.GetString() == "call_request")
            {
                var callId = doc.RootElement.GetProperty("callId").GetString() ?? "";
                var tool = doc.RootElement.GetProperty("tool").GetString() ?? "";
                var docKey = doc.RootElement.TryGetProperty("documentKey", out var dk) ? dk.GetString() : null;
                var dryRun = doc.RootElement.TryGetProperty("dryRun", out var dr) && dr.GetBoolean();
                var payloadJson = doc.RootElement.TryGetProperty("payload", out var pl) ? pl.GetRawText() : "{}";

                var reply = await _dispatcher.EnqueueAndExecuteAsync(
                    new RevitCallCommand(callId, tool, docKey, dryRun, payloadJson),
                    ct);

                await SendJsonAsync(ws, reply, ct);
            }
        }
    }

    private static Task SendJsonAsync(ClientWebSocket ws, object payload, CancellationToken ct)
    {
        var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(payload));
        return ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, ct);
    }

    public void Dispose()
    {
        _cts.Cancel();
        _ws?.Dispose();
        _cts.Dispose();
    }
}
