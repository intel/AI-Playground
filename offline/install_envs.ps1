$ErrorActionPreference = "Stop"


$scriptDir = $PSScriptRoot
$offlineResourceDir = "$scriptDir"

$installDir = (Get-Item $scriptDir).Parent.FullName
if ($args.Count -gt 0) {
    $installDir = $args -join " "
}
Write-Host "Install directory: $installDir"
Write-Host "Source directory: $offlineResourceDir"

# show a message box to ask user to select the environment to install
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = "Install Backends for AI Playground"
$form.Size = New-Object System.Drawing.Size(300, 230)
$form.StartPosition = "CenterScreen"
# make the form not resizable and not maximizable and not minimizable and not closable
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
$form.ControlBox = $false


# add a label
$label = New-Object System.Windows.Forms.Label
$label.Text = "Please select the environment to install:"
$label.Location = New-Object System.Drawing.Point(20, 20)
$label.Size = New-Object System.Drawing.Size(250, 20)
$form.Controls.Add($label)

# add checkboxes
$checkboxil = New-Object System.Windows.Forms.CheckBox
$checkboxil.Text = "AI-Playground Backend"
$checkboxil.Location = New-Object System.Drawing.Point(20, 50)
$checkboxil.Size = New-Object System.Drawing.Size(200, 20)
$checkboxil.Checked = $true
$form.Controls.Add($checkboxil)

$checkboxcf = New-Object System.Windows.Forms.CheckBox
$checkboxcf.Text = "ComfyUI"
$checkboxcf.Checked = $true
$checkboxcf.Location = New-Object System.Drawing.Point(20, 70)
$form.Controls.Add($checkboxcf)

$checkboxov = New-Object System.Windows.Forms.CheckBox
$checkboxov.Text = "OpenVINO"
$checkboxov.Location = New-Object System.Drawing.Point(20, 90)
$checkboxov.Checked = $true
$form.Controls.Add($checkboxov)

$checkboxlc = New-Object System.Windows.Forms.CheckBox
$checkboxlc.Text = "LlamaCPP"
$checkboxlc.Location = New-Object System.Drawing.Point(20, 110)
$form.Controls.Add($checkboxlc)

$button = New-Object System.Windows.Forms.Button
$button.Text = "OK"
$button.Location = New-Object System.Drawing.Point(180, 150)
$button.Add_Click({
    $envs = ""
    $names = ""
    if ($checkboxil.Checked) {
        Write-Host "Ipex-llm is checked"
        $envs += "ai-backend "
        $names += "Ipex-LLM "
    }
    if ($checkboxcf.Checked) {
        Write-Host "ComfyUI is checked"
        $envs += "comfyui "
        $names += "ComfyUI "
    }
    if ($checkboxov.Checked) {
        Write-Host "OpenVINO is checked"
        $envs += "ov "
        $names += "OpenVINO "
    }

    if ($checkboxlc.Checked) {
        Write-Host "LlamaCPP is checked"
        $envs += "llamacpp "
        $names += "LlamaCPP "
    }

    Write-Host "Selected environments: $envs"
    if ($envs -eq "") {
        Write-Host "No environments selected. Exiting..."
        $form.Close()
        return
    }

    Write-Host "Installing Backends: $envs"

    # remove all controls in $form and show only a message "Installing Backends..."
    $form.Controls.Clear()
    $label = New-Object System.Windows.Forms.Label
    $label.Text = "Installing Backends: (please be patient)..."
    $label.Location = New-Object System.Drawing.Point(20, 20)
    $label.Size = New-Object System.Drawing.Size(250, 20)
    $form.Controls.Add($label)


    # Create a PictureBox to display the GIF
    $gifPath = Join-Path $scriptDir "installing.png"
    $pictureBox = New-Object System.Windows.Forms.PictureBox
    $pictureBox.Image = [System.Drawing.Image]::FromFile($gifPath)
    $pictureBox.Location = New-Object System.Drawing.Point(0, 50)
    $pictureBox.Size = New-Object System.Drawing.Size(200, 66)
    $pictureBox.SizeMode = [System.Windows.Forms.PictureBoxSizeMode]::StretchImage
    $form.Controls.Add($pictureBox)
    
    $form.Refresh()
    
    $scriptPath = Join-Path $offlineResourceDir "setup_all.ps1"
    & $scriptPath installdir="$installDir" envs="$envs"
    Write-Host "Environments installed successfully."
    
    # [System.Windows.Forms.MessageBox]::Show("Setup files copied successfully!", "Success", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information)
    $form.Close()
})
$form.Controls.Add($button)

$form.Add_Shown({$form.Activate()})
[void]$form.ShowDialog()