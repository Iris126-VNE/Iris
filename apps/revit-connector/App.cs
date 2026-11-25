using System.IO;
using System.Text.Json;
using Autodesk.Revit.UI;
using RevitMcpConnector.Core;
using RevitMcpConnector.Transport;

namespace RevitMcpConnector;

public sealed class ConnectorSettings
{
    public string HubWsUrl { get; set; } = "ws://localhost:8765/ws/connector";
    public string ApiKey { get; set; } = "dev-secret-key";
    public string MachineAlias { get; set; } = Environment.MachineName;
}

public sealed class App : IExternalApplication
{
    private HubWebSocketClient? _wsClient;
    private ExternalEventDispatcher? _dispatcher;

    public Result OnStartup(UIControlledApplication application)
    {
        try
        {
            var settings = LoadSettings();
            var revitYear = int.TryParse(application.ControlledApplication.VersionNumber, out var y) ? y : 2025;

            _dispatcher = new ExternalEventDispatcher(application, revitYear);
            _wsClient = new HubWebSocketClient(settings, revitYear, _dispatcher);
            _wsClient.Start();

            return Result.Succeeded;
        }
        catch (Exception ex)
        {
            TaskDialog.Show("Revit MCP Connector", $"Failed to start connector: {ex.Message}");
            return Result.Failed;
        }
    }

    public Result OnShutdown(UIControlledApplication application)
    {
        _wsClient?.Dispose();
        _dispatcher?.Dispose();
        return Result.Succeeded;
    }

    private static ConnectorSettings LoadSettings()
    {
        var dir = Path.GetDirectoryName(typeof(App).Assembly.Location) ?? AppContext.BaseDirectory;
        var path = Path.Combine(dir, "connector.settings.json");
        if (!File.Exists(path)) return new ConnectorSettings();

        var json = File.ReadAllText(path);
        return JsonSerializer.Deserialize<ConnectorSettings>(json, new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true
        }) ?? new ConnectorSettings();
    }
}
