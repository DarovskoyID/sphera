"""Native verification gates. Missing SDK/account/certificate always rejects."""
import hashlib
import os
from pathlib import Path
import re
import subprocess
import base64
from release_v1 import MAX_FILE


def artifact_digest(artifact):
    path = Path(artifact)
    if path.is_symlink() or not path.is_file() or not 0 < path.stat().st_size <= MAX_FILE:
        raise ValueError('release_artifact_size_or_path')
    digest = hashlib.sha256()
    size = 0
    with path.open('rb') as stream:
        while chunk := stream.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_FILE: raise ValueError('release_artifact_size_or_path')
            digest.update(chunk)
    if size == 0: raise ValueError('release_artifact_size_or_path')
    return digest.hexdigest()


def verify_platform(platform, artifact, publisher, *, java=None, apksigner=None, aapt=None, sequence=None, version=None):
    before = artifact_digest(artifact)
    path = Path(artifact).resolve(strict=True)
    if platform == 'linux-server-source':
        from server_release import archive_members
        archive_members(path)
    elif platform == 'windows-x64':
        if os.name != 'nt': raise ValueError('windows_signature_verifier_required')
        # Paths are environment data, never interpolated into PowerShell code.
        script = """$ErrorActionPreference='Stop'; $s=Get-AuthenticodeSignature -LiteralPath $env:SPHERE_RELEASE_ARTIFACT;
if($s.Status -ne 'Valid' -or $null -eq $s.SignerCertificate){throw 'Authenticode signature rejected'};
$h=[System.Security.Cryptography.SHA256]::Create();
try{$p=([BitConverter]::ToString($h.ComputeHash($s.SignerCertificate.RawData))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()};
if($p -cne $env:SPHERE_RELEASE_PUBLISHER){throw 'Publisher mismatch'}"""
        command = ['powershell.exe','-NoProfile','-NonInteractive','-EncodedCommand',base64.b64encode(script.encode('utf-16le')).decode()]
        subprocess.run(command, env={**os.environ,'SPHERE_RELEASE_ARTIFACT':str(path),'SPHERE_RELEASE_PUBLISHER':publisher},
            check=True, capture_output=True, timeout=90)
    elif platform == 'android-universal':
        if not java or not apksigner or not Path(java).is_file() or not Path(apksigner).is_file(): raise ValueError('android_sdk_signature_verifier_required')
        result = subprocess.run([str(java),'-jar',str(apksigner),'verify','--verbose','--print-certs',str(path)],
            check=True, capture_output=True, timeout=90, text=True)
        certificates = re.findall(r'^Signer #\d+ certificate SHA-256 digest: ([0-9a-fA-F]{64})$',result.stdout,re.M)
        if [value.lower() for value in certificates] != [publisher] or not re.search(r'Verified using v[23].*: true',result.stdout):
            raise ValueError('android_apk_signature_rejected')
        if 'CN=Android Debug' in result.stdout: raise ValueError('debug_android_identity_not_a_production_publisher')
        if not aapt or not Path(aapt).is_file(): raise ValueError('android_package_metadata_verifier_required')
        package=subprocess.run([str(aapt),'dump','badging',str(path)],check=True,capture_output=True,timeout=60,encoding='utf-8')
        identity=re.search(r"^package: name='([^']+)' versionCode='([0-9]+)' versionName='([^']*)'",package.stdout,re.M)
        if not identity or identity.group(1)!='com.sfera.ru' or int(identity.group(2))!=sequence or identity.group(3)!=version or 'application-debuggable' in package.stdout or 'application-testOnly' in package.stdout:
            raise ValueError('android_release_package_or_version_mismatch')
    elif platform.startswith('macos-'):
        if not Path('/usr/sbin/pkgutil').exists(): raise ValueError('macos_signature_verifier_required')
        result = subprocess.run(['/usr/sbin/pkgutil','--check-signature',str(path)],check=True,capture_output=True,text=True,timeout=90)
        if not re.search(r'Developer ID Installer: .+ \('+re.escape(publisher)+r'\)', result.stdout): raise ValueError('apple_team_mismatch')
        assessment=subprocess.run(['/usr/sbin/spctl','--assess','--type','install','--verbose=4',str(path)],check=True,capture_output=True,timeout=90,text=True,env={**os.environ,'LC_ALL':'C'})
        if 'source=Notarized Developer ID' not in assessment.stdout+assessment.stderr: raise ValueError('macos_notarization_required')
    else:
        raise ValueError('platform_artifact_verifier_unavailable')
    after = artifact_digest(path)
    if before != after: raise ValueError('artifact_changed_during_verification')
    return after
