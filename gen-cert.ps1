# DEEPREEL 本地 HTTPS 证书生成脚本（Windows）
# 用法：pwsh -File gen-cert.ps1 -Ip 192.168.2.13
# 说明：证书绑定到你的局域网 IP；IP 变了重新运行一次即可。
param([string]$Ip = "192.168.2.13")

$ossl = @("C:\Program Files\Git\usr\bin\openssl.exe", "D:\Program Files\Git\usr\bin\openssl.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $ossl) {
  $g = Get-Command openssl -ErrorAction SilentlyContinue
  if ($g) { $ossl = $g.Source } else { Write-Error "未找到 openssl（请安装 Git for Windows）"; exit 1 }
}

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$certDir = Join-Path $dir "certs"
New-Item -ItemType Directory -Force -Path $certDir | Out-Null

& $ossl req -x509 -newkey rsa:2048 -keyout (Join-Path $certDir "key.pem") -out (Join-Path $certDir "cert.pem") -days 825 -nodes -subj "/CN=$Ip" -addext "subjectAltName=IP:$Ip" 2>&1 | Out-Null
& $ossl x509 -in (Join-Path $certDir "cert.pem") -outform DER -out (Join-Path $certDir "deepreel-cert.cer") 2>&1 | Out-Null

Write-Output "证书已生成："
Write-Output "  certs/cert.pem + key.pem  （代理 https 服务使用，端口 7443）"
Write-Output "  certs/deepreel-cert.cer   （手机安装用：下载此文件并信任）"
Write-Output ""
Write-Output "手机安装后访问：https://$Ip`:7443/"
