# PowerShell script to display the loading.gif in a form
$ErrorActionPreference = "Stop"

# Get script directory
$scriptDir = $PSScriptRoot
$gifPath = Join-Path $scriptDir "loading.gif"

# Check if the GIF exists
if (-not (Test-Path $gifPath)) {
    Write-Host "Error: loading.gif not found at path: $gifPath" -ForegroundColor Red
    exit 1
}

# Add required assemblies
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Create a form
$form = New-Object System.Windows.Forms.Form
$form.Text = "Loading GIF Viewer"
$form.Size = New-Object System.Drawing.Size(300, 300)
$form.StartPosition = "CenterScreen"

# Create a label with instructions
$label = New-Object System.Windows.Forms.Label
$label.Text = "Loading GIF Demo (Close window to exit)"
$label.Location = New-Object System.Drawing.Point(20, 20)
$label.Size = New-Object System.Drawing.Size(250, 20)
$form.Controls.Add($label)

# Create a PictureBox to display the GIF
$pictureBox = New-Object System.Windows.Forms.PictureBox
$pictureBox.Image = [System.Drawing.Image]::FromFile($gifPath)
$pictureBox.Location = New-Object System.Drawing.Point(75, 50)
$pictureBox.Size = New-Object System.Drawing.Size(150, 150)
$pictureBox.SizeMode = [System.Windows.Forms.PictureBoxSizeMode]::StretchImage
$form.Controls.Add($pictureBox)

# Add a Close button
$button = New-Object System.Windows.Forms.Button
$button.Text = "Close"
$button.Location = New-Object System.Drawing.Point(110, 220)
$button.Add_Click({ $form.Close() })
$form.Controls.Add($button)

# Show the form
$form.Add_Shown({$form.Activate()})
[void]$form.ShowDialog()
