$ErrorActionPreference = "Stop"

$Root = "c:\flydieqqe\flyqa-ios"
$DistDir = Join-Path $Root "dist"
$StageDir = Join-Path $DistDir "_stage"
$PayloadDir = Join-Path $StageDir "Payload"
$AppBundleDir = Join-Path $PayloadDir "flyqa.app"
$PublicDir = Join-Path $AppBundleDir "public"
$IpaPath = Join-Path $DistDir "flyqa.ipa"

if (Test-Path $StageDir) { Remove-Item $StageDir -Recurse -Force }
if (Test-Path $IpaPath) { Remove-Item $IpaPath -Force }
New-Item -ItemType Directory -Force -Path $PublicDir | Out-Null

# 1. Generate valid iOS Info.plist manifest
$infoPlist = @'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key>
	<string>ru</string>
	<key>CFBundleDisplayName</key>
	<string>flyqa</string>
	<key>CFBundleExecutable</key>
	<string>flyqa</string>
	<key>CFBundleIdentifier</key>
	<string>com.flyqa.music</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>flyqa</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>1.0.0</string>
	<key>CFBundleVersion</key>
	<string>1.0.0</string>
	<key>LSRequiresIPhoneOS</key>
	<true/>
	<key>MinimumOSVersion</key>
	<string>13.0</string>
	<key>UIBackgroundModes</key>
	<array>
		<string>audio</string>
	</array>
	<key>UIRequiresFullScreen</key>
	<true/>
	<key>UILaunchStoryboardName</key>
	<string>LaunchScreen</string>
	<key>UISupportedInterfaceOrientations</key>
	<array>
		<string>UIInterfaceOrientationPortrait</string>
	</array>
	<key>UIViewControllerBasedStatusBarAppearance</key>
	<true/>
</dict>
</plist>
'@
[System.IO.File]::WriteAllText((Join-Path $AppBundleDir "Info.plist"), $infoPlist, (New-Object System.Text.UTF8Encoding($false)))

# 2. PkgInfo & Capacitor config
[System.IO.File]::WriteAllText((Join-Path $AppBundleDir "PkgInfo"), "APPL????", [System.Text.Encoding]::ASCII)
Copy-Item (Join-Path $Root "capacitor.config.json") (Join-Path $AppBundleDir "capacitor.config.json") -Force

# 3. Copy web assets (HTML, CSS, JS, Supabase, Icons) into public/
Copy-Item (Join-Path $Root "www\*") $PublicDir -Recurse -Force

$IconPng = Join-Path $Root "www\assets\icon.png"
if (Test-Path $IconPng) {
  Copy-Item $IconPng (Join-Path $AppBundleDir "AppIcon60x60@2x.png") -Force
  Copy-Item $IconPng (Join-Path $AppBundleDir "AppIcon60x60@3x.png") -Force
}

# 4. Package Payload/ into flyqa.ipa with POSIX forward-slash entry names
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open($IpaPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  $allFiles = Get-ChildItem -Path $PayloadDir -Recurse -File
  foreach ($f in $allFiles) {
    $relPath = $f.FullName.Substring($StageDir.Length + 1).Replace("\", "/")
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.FullName, $relPath, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
  }
} finally {
  $zip.Dispose()
}

Remove-Item $StageDir -Recurse -Force
Write-Output "Built IPA: $IpaPath"
