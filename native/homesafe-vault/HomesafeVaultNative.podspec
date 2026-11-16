Pod::Spec.new do |s|
  s.name = 'HomesafeVaultNative'
  s.version = '1.0.0'
  s.summary = 'HomeSafe file access and local Vault transfer'
  s.license = 'Proprietary'
  s.homepage = 'https://hearthside-private-backup.lovable.app'
  s.author = 'HomeSafe'
  s.source = { :git => 'local', :tag => s.version.to_s }
  s.source_files = 'ios/Sources/**/*.swift'
  s.ios.deployment_target = '15.0'
  s.dependency 'Capacitor'
  s.swift_version = '5.9'
end
