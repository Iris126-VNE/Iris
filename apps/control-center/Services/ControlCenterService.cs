using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Text.Json;

namespace IrisControlCenter.Services;

public sealed class AppSettings
{
    public string ServerUrl { get; set; } = "https://revit-mcp-hub.onrender.com";
    public string ApiKey { get; set; } = "";
    public string MachineAlias { get; set; } = Environment.MachineName;
}

public sealed class RevitInstallItem
{
    public int Year { get; set; }
    public bool IsRevitInstalled { get; set; }
    public bool IsConnectorInstalled { get; set; }
    public bool IsSelected { get; set; }
    public string StatusText =>
        IsConnectorInstalled
            ? $"Revit {Year} — Đã cài Connector"
            : IsRevitInstalled
                ? $"Revit {Year} — Đã phát hiện (chưa cài)"
                : $"Revit {Year} — Không phát hiện trên máy";
}

public sealed class HealthCheckResult
{
    public bool IsOnline { get; set; }
    public string CatalogVersion { get; set; } = "-";
    public string Message { get; set; } = "";
}

public sealed class ControlCenterService
{
    private static readonly int[] SupportedYears = new[] { 2022, 2023, 2024, 2025, 2026 };
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(15) };
    private static readonly JsonSerializerOptions JsonOpts = new() { WriteIndented = true, PropertyNameCaseInsensitive = true };

    public string SettingsPath { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "IrisRevitMcp",
        "control-center.settings.json");

    public AppSettings LoadSettings()
    {
        try
        {
            if (File.Exists(SettingsPath))
            {
                var json = File.ReadAllText(SettingsPath);
                return JsonSerializer.Deserialize<AppSettings>(json, JsonOpts) ?? new AppSettings();
            }
        }
        catch { /* fall back to defaults */ }
        return new AppSettings();
    }

    public void SaveSettings(AppSettings settings)
    {
        var dir = Path.GetDirectoryName(SettingsPath)!;
        Directory.CreateDirectory(dir);
        File.WriteAllText(SettingsPath, JsonSerializer.Serialize(settings, JsonOpts));

        // Sync settings to any already-installed Revit connector folders
        foreach (var year in SupportedYears)
        {
            var connectorDir = GetConnectorInstallDir(year);
            if (Directory.Exists(connectorDir))
            {
                WriteConnectorSettingsFile(connectorDir, settings);
            }
        }
    }

    public List<RevitInstallItem> DetectRevitInstallations()
    {
        var list = new List<RevitInstallItem>();
        foreach (var year in SupportedYears)
        {
            var programDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                "Autodesk",
                $"Revit {year}");
            var addinsDir = GetRevitAddinsDir(year);
            var addinManifest = Path.Combine(addinsDir, "RevitMcpConnector.addin");

            var revitDetected = Directory.Exists(programDir) || Directory.Exists(addinsDir);
            var connectorInstalled = File.Exists(addinManifest);

            list.Add(new RevitInstallItem
            {
                Year = year,
                IsRevitInstalled = revitDetected,
                IsConnectorInstalled = connectorInstalled,
                IsSelected = revitDetected
            });
        }
        return list;
    }

    public bool IsRevitProcessRunning()
    {
        return Process.GetProcessesByName("Revit").Length > 0;
    }

    public async Task<HealthCheckResult> CheckServerHealthAsync(string serverUrl)
    {
        try
        {
            var baseUrl = NormalizeHttpUrl(serverUrl);
            var resp = await Http.GetAsync($"{baseUrl}/health");
            if (!resp.IsSuccessStatusCode)
            {
                return new HealthCheckResult { IsOnline = false, Message = $"HTTP {(int)resp.StatusCode}" };
            }

            var body = await resp.Content.ReadAsStringAsync();
            using var doc = JsonDocument.Parse(body);
            var cat = doc.RootElement.TryGetProperty("catalogVersion", out var cv) ? (cv.GetString() ?? "-") : "-";
            return new HealthCheckResult
            {
                IsOnline = true,
                CatalogVersion = cat.Length > 12 ? cat.Substring(0, 12) + "..." : cat,
                Message = "Online"
            };
        }
        catch (Exception ex)
        {
            return new HealthCheckResult { IsOnline = false, Message = ex.Message };
        }
    }

    public (bool Ok, string Message) InstallConnectorForYear(int year, AppSettings settings)
    {
        var bundleKey = year <= 2024 ? "revit2024" : "revit2025";
        var sourceBase = Path.Combine(AppContext.BaseDirectory, "connectors", bundleKey);
        var sourceManifest = Path.Combine(sourceBase, "RevitMcpConnector.addin");
        var sourceBinDir = Path.Combine(sourceBase, "RevitMcpConnector");

        if (!File.Exists(sourceManifest) || !Directory.Exists(sourceBinDir))
        {
            return (false, $"Không tìm thấy gói build sẵn tại '{sourceBase}'. Hãy tải bản đóng gói đầy đủ từ GitHub Actions.");
        }

        var targetAddins = GetRevitAddinsDir(year);
        var targetBinDir = GetConnectorInstallDir(year);
        Directory.CreateDirectory(targetAddins);
        Directory.CreateDirectory(targetBinDir);

        File.Copy(sourceManifest, Path.Combine(targetAddins, "RevitMcpConnector.addin"), overwrite: true);
        CopyDirectory(sourceBinDir, targetBinDir);
        WriteConnectorSettingsFile(targetBinDir, settings);

        return (true, $"Đã cài đặt Connector cho Revit {year} thành công.");
    }

    public (bool Ok, string Message) UninstallConnectorForYear(int year)
    {
        var addinsDir = GetRevitAddinsDir(year);
        var manifest = Path.Combine(addinsDir, "RevitMcpConnector.addin");
        var binDir = GetConnectorInstallDir(year);

        if (File.Exists(manifest)) File.Delete(manifest);
        if (Directory.Exists(binDir)) Directory.Delete(binDir, recursive: true);

        return (true, $"Đã gỡ Connector khỏi Revit {year}.");
    }

    public string BuildMcpClientConfigJson(AppSettings settings)
    {
        var baseUrl = NormalizeHttpUrl(settings.ServerUrl);
        var token = string.IsNullOrWhiteSpace(settings.ApiKey) ? "<API_KEY>" : settings.ApiKey.Trim();
        var obj = new
        {
            mcpServers = new Dictionary<string, object>
            {
                ["iris-revit-mcp"] = new
                {
                    serverUrl = $"{baseUrl}/mcp",
                    headers = new Dictionary<string, string>
                    {
                        ["Authorization"] = $"Bearer {token}"
                    }
                }
            }
        };
        return JsonSerializer.Serialize(obj, JsonOpts);
    }

    public static string NormalizeHttpUrl(string url)
    {
        var trimmed = (url ?? "").Trim().TrimEnd('/');
        if (string.IsNullOrEmpty(trimmed)) return "https://revit-mcp-hub.onrender.com";
        if (!trimmed.StartsWith("http://", StringComparison.OrdinalIgnoreCase) &&
            !trimmed.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
        {
            trimmed = "https://" + trimmed;
        }
        return trimmed;
    }

    public static string ToWebSocketUrl(string httpUrl)
    {
        var norm = NormalizeHttpUrl(httpUrl);
        if (norm.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
        {
            return "wss://" + norm.Substring(8) + "/ws/connector";
        }
        if (norm.StartsWith("http://", StringComparison.OrdinalIgnoreCase))
        {
            return "ws://" + norm.Substring(7) + "/ws/connector";
        }
        return norm + "/ws/connector";
    }

    public static string GetRevitAddinsDir(int year) => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "Autodesk",
        "Revit",
        "Addins",
        year.ToString());

    public static string GetConnectorInstallDir(int year) => Path.Combine(GetRevitAddinsDir(year), "RevitMcpConnector");

    private static void WriteConnectorSettingsFile(string connectorDir, AppSettings settings)
    {
        var payload = new
        {
            hubWsUrl = ToWebSocketUrl(settings.ServerUrl),
            apiKey = settings.ApiKey.Trim(),
            machineAlias = string.IsNullOrWhiteSpace(settings.MachineAlias) ? Environment.MachineName : settings.MachineAlias.Trim()
        };
        File.WriteAllText(Path.Combine(connectorDir, "connector.settings.json"), JsonSerializer.Serialize(payload, JsonOpts));
    }

    private static void CopyDirectory(string sourceDir, string targetDir)
    {
        Directory.CreateDirectory(targetDir);
        foreach (var file in Directory.GetFiles(sourceDir))
        {
            var name = Path.GetFileName(file);
            if (string.Equals(name, "connector.settings.json", StringComparison.OrdinalIgnoreCase)) continue;
            File.Copy(file, Path.Combine(targetDir, name), overwrite: true);
        }
        foreach (var dir in Directory.GetDirectories(sourceDir))
        {
            CopyDirectory(dir, Path.Combine(targetDir, Path.GetFileName(dir)));
        }
    }
}
