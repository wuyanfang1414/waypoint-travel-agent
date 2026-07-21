$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $project

$address = Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object {
        $_.IPAddress -notlike '127.*' -and
        $_.IPAddress -notlike '169.254.*' -and
        $_.InterfaceAlias -notmatch 'Loopback|Virtual|VMware|Hyper-V|WSL'
    } |
    Sort-Object -Property InterfaceMetric |
    Select-Object -First 1 -ExpandProperty IPAddress

Write-Host "Waypoint is available on this computer: http://127.0.0.1:8877"
if ($address) {
    Write-Host "Open this address on a phone connected to the same Wi-Fi: http://${address}:8877"
} else {
    Write-Host "No LAN IPv4 address was found. Check that Wi-Fi is connected."
}

python server.py --host 0.0.0.0 --port 8877

