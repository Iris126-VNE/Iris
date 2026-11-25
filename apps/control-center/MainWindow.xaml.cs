using System.Windows;
using System.Windows.Media;
using System.Windows.Threading;
using IrisControlCenter.Services;

namespace IrisControlCenter;

public partial class MainWindow : Window
{
    private readonly ControlCenterService _service = new();
    private readonly DispatcherTimer _timer = new() { Interval = TimeSpan.FromSeconds(15) };
    private List<RevitInstallItem> _revitItems = new();

    public MainWindow()
    {
        InitializeComponent();
        LoadInitialState();

        _timer.Tick += async (_, _) => await RefreshLiveStatusAsync();
        _timer.Start();
        Loaded += async (_, _) => await RefreshLiveStatusAsync();
    }

    private void LoadInitialState()
    {
        var settings = _service.LoadSettings();
        ServerUrlBox.Text = settings.ServerUrl;
        ApiKeyBox.Text = settings.ApiKey;
        MachineAliasBox.Text = settings.MachineAlias;

        RefreshRevitList();
        AppendLog("Iris Control Center sẵn sàng.");
    }

    private AppSettings ReadFormSettings() => new()
    {
        ServerUrl = ServerUrlBox.Text.Trim(),
        ApiKey = ApiKeyBox.Text.Trim(),
        MachineAlias = MachineAliasBox.Text.Trim()
    };

    private void RefreshRevitList()
    {
        _revitItems = _service.DetectRevitInstallations();
        RevitListControl.ItemsSource = null;
        RevitListControl.ItemsSource = _revitItems;
        UpdateRevitRunningIndicator();
    }

    private void UpdateRevitRunningIndicator()
    {
        var running = _service.IsRevitProcessRunning();
        RevitRunningText.Text = running ? "Revit.exe: Đang chạy" : "Revit.exe: Chưa mở";
        RevitRunningText.Foreground = new SolidColorBrush(running ? Color.FromRgb(52, 211, 153) : Color.FromRgb(148, 163, 184));
    }

    private async Task RefreshLiveStatusAsync()
    {
        UpdateRevitRunningIndicator();
        var health = await _service.CheckServerHealthAsync(ServerUrlBox.Text);
        if (health.IsOnline)
        {
            StatusDot.Fill = new SolidColorBrush(Color.FromRgb(34, 197, 94));
            StatusText.Text = "Server Online";
            CatalogInfoText.Text = $"Server: {ControlCenterService.NormalizeHttpUrl(ServerUrlBox.Text)} | Catalog: {health.CatalogVersion}";
        }
        else
        {
            StatusDot.Fill = new SolidColorBrush(Color.FromRgb(239, 68, 68));
            StatusText.Text = "Server Offline";
            CatalogInfoText.Text = $"Không kết nối được Server ({health.Message})";
        }
    }

    private void OnSaveSettingsClick(object sender, RoutedEventArgs e)
    {
        var settings = ReadFormSettings();
        _service.SaveSettings(settings);
        AppendLog("Đã lưu cấu hình và đồng bộ xuống các Revit Connector đã cài.");
        _ = RefreshLiveStatusAsync();
    }

    private async void OnCheckServerClick(object sender, RoutedEventArgs e)
    {
        AppendLog("Đang kiểm tra kết nối Server...");
        await RefreshLiveStatusAsync();
        AppendLog($"Trạng thái: {StatusText.Text} — {CatalogInfoText.Text}");
    }

    private void OnCopyMcpConfigClick(object sender, RoutedEventArgs e)
    {
        var settings = ReadFormSettings();
        var json = _service.BuildMcpClientConfigJson(settings);
        Clipboard.SetText(json);
        AppendLog("Đã copy JSON cấu hình MCP vào Clipboard! Dán vào MCP config của Antigravity/IDE.");
    }

    private void OnInstallConnectorsClick(object sender, RoutedEventArgs e)
    {
        var settings = ReadFormSettings();
        if (string.IsNullOrWhiteSpace(settings.ApiKey))
        {
            MessageBox.Show("Vui lòng nhập API Key trước khi cài đặt Add-in.", "Thiếu API Key", MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        _service.SaveSettings(settings);
        var selected = _revitItems.Where(x => x.IsSelected).ToList();
        if (selected.Count == 0)
        {
            AppendLog("Chưa chọn phiên bản Revit nào.");
            return;
        }

        foreach (var item in selected)
        {
            try
            {
                var (ok, msg) = _service.InstallConnectorForYear(item.Year, settings);
                AppendLog(ok ? $"[OK] {msg}" : $"[LỖI] {msg}");
            }
            catch (Exception ex)
            {
                AppendLog($"[LỖI] Revit {item.Year}: {ex.Message} (Hãy đóng Revit trước khi cập nhật DLL)");
            }
        }
        RefreshRevitList();
    }

    private void OnUninstallConnectorsClick(object sender, RoutedEventArgs e)
    {
        var selected = _revitItems.Where(x => x.IsSelected && x.IsConnectorInstalled).ToList();
        if (selected.Count == 0)
        {
            AppendLog("Không có phiên bản Revit nào đang cài Connector được chọn để gỡ.");
            return;
        }

        foreach (var item in selected)
        {
            try
            {
                var (_, msg) = _service.UninstallConnectorForYear(item.Year);
                AppendLog($"[OK] {msg}");
            }
            catch (Exception ex)
            {
                AppendLog($"[LỖI] Không gỡ được Revit {item.Year}: {ex.Message}");
            }
        }
        RefreshRevitList();
    }

    private void OnRefreshRevitClick(object sender, RoutedEventArgs e)
    {
        RefreshRevitList();
        AppendLog("Đã quét lại danh sách Revit trên máy.");
    }

    private void AppendLog(string message)
    {
        var line = $"[{DateTime.Now:HH:mm:ss}] {message}{Environment.NewLine}";
        LogBox.AppendText(line);
        LogBox.ScrollToEnd();
    }
}
