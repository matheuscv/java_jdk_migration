# Executar como Administrador
# Altera JAVA_HOME permanente (sistema) de zulu-8 para zulu-21

$newJavaHome = "C:\Program Files\Zulu\zulu-21"
$regPath = "HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment"

Set-ItemProperty -Path $regPath -Name JAVA_HOME -Value $newJavaHome -Type String

# Notifica o sistema sobre a mudança (sem reiniciar)
$null = [System.Environment]::SetEnvironmentVariable("JAVA_HOME", $newJavaHome, "Machine")

Write-Host "JAVA_HOME atualizado para: $newJavaHome"
Write-Host "Valor no registro: $((Get-ItemProperty -Path $regPath -Name JAVA_HOME).JAVA_HOME)"
Write-Host ""
Write-Host "Abra um novo terminal para confirmar com: java -version"
