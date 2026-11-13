$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient

function Get-ForegroundJson {
  try {
    $element = [System.Windows.Automation.AutomationElement]::FocusedElement
    if (-not $element) { throw 'No focused window.' }
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $window = $element
    while ($true) {
      $parent = $walker.GetParent($window)
      if (-not $parent -or $parent -eq $root) { break }
      $window = $parent
    }
    $rect = $window.Current.BoundingRectangle
    $procId = [int]$window.Current.ProcessId
    $name = ''
    if ($procId -ne 0) {
      $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
      if ($proc) { $name = $proc.ProcessName }
    }
    @{
      app = $name
      title = [string]$window.Current.Name
      left = [int]$rect.Left
      top = [int]$rect.Top
      right = [int]$rect.Right
      bottom = [int]$rect.Bottom
    } | ConvertTo-Json -Compress
  } catch {
    '{"app":"","title":"","left":0,"top":0,"right":0,"bottom":0}'
  }
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  [Console]::Out.WriteLine((Get-ForegroundJson))
}
