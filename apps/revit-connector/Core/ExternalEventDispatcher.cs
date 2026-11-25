using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using Autodesk.Revit.UI.Events;

namespace RevitMcpConnector.Core;

public sealed record RevitCallCommand(
    string CallId,
    string Tool,
    string? DocumentKey,
    bool DryRun,
    string PayloadJson);

public sealed class ExternalEventDispatcher : IExternalEventHandler, IDisposable
{
    private readonly UIControlledApplication _uiControlledApp;
    private readonly int _revitYear;
    private readonly ExternalEvent _externalEvent;
    private readonly ConcurrentQueue<(Func<UIApplication, object> Work, TaskCompletionSource<object> Tcs)> _queue = new();

    private string? _blockedDialogId;
    private bool _suppressDialogs;

    public string[] SupportedTools { get; } =
    [
        "session_get_health",
        "document_list_open",
        "level_list",
        "element_inspect",
        "parameter_batch_set_safe"
    ];

    public ExternalEventDispatcher(UIControlledApplication uiControlledApp, int revitYear)
    {
        _uiControlledApp = uiControlledApp;
        _revitYear = revitYear;
        _externalEvent = ExternalEvent.Create(this);
        _uiControlledApp.DialogBoxShowing += OnDialogBoxShowing;
    }

    private void OnDialogBoxShowing(object? sender, DialogBoxShowingEventArgs e)
    {
        if (!_suppressDialogs) return;
        _blockedDialogId = e.DialogId;
        e.OverrideResult((int)TaskDialogResult.Cancel);
    }

    public async Task<object[]> SnapshotOpenDocumentsAsync(CancellationToken ct)
    {
        var res = await RunOnRevitThreadAsync(uiApp => ListOpenDocs(uiApp), ct);
        return (object[])res;
    }

    public Task<object> EnqueueAndExecuteAsync(RevitCallCommand cmd, CancellationToken ct)
    {
        return RunOnRevitThreadAsync(uiApp => ExecuteCommand(uiApp, cmd), ct);
    }

    private Task<object> RunOnRevitThreadAsync(Func<UIApplication, object> work, CancellationToken ct)
    {
        var tcs = new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously);
        ct.Register(() => tcs.TrySetCanceled(ct));
        _queue.Enqueue((work, tcs));
        _externalEvent.Raise();
        return tcs.Task;
    }

    public void Execute(UIApplication app)
    {
        while (_queue.TryDequeue(out var item))
        {
            try
            {
                var result = item.Work(app);
                item.Tcs.TrySetResult(result);
            }
            catch (Exception ex)
            {
                item.Tcs.TrySetResult(new
                {
                    type = "call_result",
                    callId = "unknown",
                    status = "failed",
                    statusCode = "TOOL_CRASH",
                    error = new
                    {
                        code = "TOOL_CRASH",
                        message = ex.Message,
                        errorClass = "fatal",
                        outcomeUncertain = true
                    }
                });
            }
        }
    }

    public string GetName() => "RevitMcpConnector.ExternalEventDispatcher";

    private object ExecuteCommand(UIApplication uiApp, RevitCallCommand cmd)
    {
        _blockedDialogId = null;
        _suppressDialogs = true;
        try
        {
            if (cmd.Tool == "session_get_health")
            {
                return Ok(cmd.CallId, new { ok = true, revitYear = _revitYear, queueDepth = _queue.Count });
            }

            if (cmd.Tool == "document_list_open")
            {
                return Ok(cmd.CallId, new { documents = ListOpenDocs(uiApp) });
            }

            var doc = ResolveDocument(uiApp, cmd.DocumentKey);
            if (doc is null)
            {
                return Fail(cmd.CallId, "DOCUMENT_NOT_FOUND", "fatal", "No open Revit document matched documentKey.");
            }

            if (cmd.Tool == "level_list")
            {
                var levels = new FilteredElementCollector(doc)
                    .OfClass(typeof(Level))
                    .Cast<Level>()
                    .OrderBy(l => l.Elevation)
                    .Select(l => new
                    {
                        id = GetElementIdValue(l.Id),
                        name = l.Name,
                        elevationMeter = Math.Round(UnitUtils.ConvertFromInternalUnits(l.Elevation, UnitTypeId.Meters), 4)
                    })
                    .ToArray();
                return Ok(cmd.CallId, new { levels });
            }

            if (cmd.Tool == "element_inspect")
            {
                using var payloadDoc = JsonDocument.Parse(cmd.PayloadJson);
                var ids = payloadDoc.RootElement.GetProperty("elementIds").EnumerateArray().Select(x => x.GetInt64()).ToArray();
                var items = ids.Select(id =>
                {
                    var el = doc.GetElement(CreateElementId(id));
                    if (el is null) return (object)new { id, found = false };
                    return new
                    {
                        id,
                        found = true,
                        name = el.Name,
                        category = el.Category?.Name ?? ""
                    };
                }).ToArray();
                return Ok(cmd.CallId, new { elements = items });
            }

            if (cmd.Tool == "parameter_batch_set_safe")
            {
                return ExecuteParameterBatchSet(doc, cmd);
            }

            return Fail(cmd.CallId, "TOOL_NOT_IMPLEMENTED", "capability", $"Tool '{cmd.Tool}' is not implemented in this connector build.");
        }
        finally
        {
            _suppressDialogs = false;
        }
    }

    private object ExecuteParameterBatchSet(Document doc, RevitCallCommand cmd)
    {
        using var payloadDoc = JsonDocument.Parse(cmd.PayloadJson);
        var onlyEmpty = payloadDoc.RootElement.TryGetProperty("onlyEmpty", out var oe) && oe.GetBoolean();
        var updates = payloadDoc.RootElement.GetProperty("updates").EnumerateArray().ToArray();

        var modified = new HashSet<long>();
        var checkpointName = $"MCP: parameter_batch_set_safe ({cmd.CallId})";

        using var tg = new TransactionGroup(doc, checkpointName);
        tg.Start();
        try
        {
            using (var tx = new Transaction(doc, "MCP Parameter Update"))
            {
                tx.Start();
                foreach (var upd in updates)
                {
                    var elId = upd.GetProperty("elementId").GetInt64();
                    var paramName = upd.GetProperty("parameterName").GetString() ?? "";
                    var valElem = upd.GetProperty("value");

                    var el = doc.GetElement(CreateElementId(elId));
                    var param = el?.LookupParameter(paramName);
                    if (param is null || param.IsReadOnly) continue;
                    if (onlyEmpty && param.HasValue && !string.IsNullOrWhiteSpace(param.AsValueString())) continue;

                    if (param.StorageType == StorageType.String)
                    {
                        param.Set(valElem.ToString());
                        modified.Add(elId);
                    }
                    else if (param.StorageType == StorageType.Integer && valElem.TryGetInt32(out var iv))
                    {
                        param.Set(iv);
                        modified.Add(elId);
                    }
                    else if (param.StorageType == StorageType.Double && valElem.TryGetDouble(out var dv))
                    {
                        param.Set(dv);
                        modified.Add(elId);
                    }
                }
                tx.Commit();
            }

            if (_blockedDialogId is not null)
            {
                tg.RollBack();
                return Fail(cmd.CallId, "DIALOG_BLOCKED", "fatal", $"Revit dialog '{_blockedDialogId}' interrupted execution.");
            }

            if (cmd.DryRun)
            {
                tg.RollBack();
            }
            else
            {
                tg.Assimilate();
            }

            return new
            {
                type = "call_result",
                callId = cmd.CallId,
                status = "succeeded",
                statusCode = "OK",
                checkpointName = cmd.DryRun ? null : checkpointName,
                result = new { updatedCount = modified.Count, dryRun = cmd.DryRun },
                changes = new
                {
                    added = Array.Empty<long>(),
                    modified = modified.ToArray(),
                    deleted = Array.Empty<long>(),
                    transactionNames = new[] { "MCP Parameter Update" },
                    changeKind = cmd.DryRun ? "RolledBack" : "Committed"
                },
                warningsCount = 0
            };
        }
        catch (Exception ex)
        {
            tg.RollBack();
            return Fail(cmd.CallId, "TRANSACTION_FAILED", "fatal", ex.Message);
        }
    }

    private static object[] ListOpenDocs(UIApplication uiApp)
    {
        var active = uiApp.ActiveUIDocument?.Document;
        var list = new List<object>();
        foreach (Document doc in uiApp.Application.Documents)
        {
            if (doc.IsLinked) continue;
            list.Add(new
            {
                documentKey = ComputeDocumentKey(doc),
                title = doc.Title,
                isActive = active is not null && ReferenceEquals(doc, active),
                isFamilyDocument = doc.IsFamilyDocument,
                isReadOnly = doc.IsReadOnly
            });
        }
        return list.ToArray();
    }

    private static Document? ResolveDocument(UIApplication uiApp, string? documentKey)
    {
        if (string.IsNullOrWhiteSpace(documentKey)) return null;
        foreach (Document doc in uiApp.Application.Documents)
        {
            if (!doc.IsLinked && string.Equals(ComputeDocumentKey(doc), documentKey, StringComparison.OrdinalIgnoreCase))
            {
                return doc;
            }
        }
        return null;
    }

    private static string ComputeDocumentKey(Document doc)
    {
        var seed = string.IsNullOrWhiteSpace(doc.PathName) ? $"unsaved:{doc.Title}:{doc.GetHashCode()}" : doc.PathName.ToLowerInvariant();
        using var sha = SHA256.Create();
        var hash = sha.ComputeHash(Encoding.UTF8.GetBytes(seed));
        var sb = new StringBuilder(hash.Length * 2);
        foreach (var b in hash)
        {
            sb.Append(b.ToString("x2"));
        }
        return sb.ToString();
    }

    private static long GetElementIdValue(ElementId id)
    {
#if NET8_0_OR_GREATER
        return id.Value;
#else
        return id.IntegerValue;
#endif
    }

    private static ElementId CreateElementId(long id)
    {
#if NET8_0_OR_GREATER
        return new ElementId(id);
#else
        return new ElementId((int)id);
#endif
    }

    private static object Ok(string callId, object result) => new
    {
        type = "call_result",
        callId,
        status = "succeeded",
        statusCode = "OK",
        result
    };

    private static object Fail(string callId, string code, string errorClass, string message) => new
    {
        type = "call_result",
        callId,
        status = "failed",
        statusCode = code,
        error = new { code, message, errorClass }
    };

    public void Dispose()
    {
        _uiControlledApp.DialogBoxShowing -= OnDialogBoxShowing;
        _externalEvent.Dispose();
    }
}
