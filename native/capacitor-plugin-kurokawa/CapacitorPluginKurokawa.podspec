Pod::Spec.new do |s|
  s.name = 'CapacitorPluginKurokawa'
  s.version = '0.1.0'
  s.summary = 'KurokawaReader native helpers'
  s.license = 'MIT'
  s.homepage = 'https://github.com/YoRu72/KurokawaReader'
  s.author = 'KurokawaReader'
  s.source = { :git => 'https://github.com/YoRu72/KurokawaReader.git', :tag => s.version.to_s }
  s.source_files = 'ios/Plugin/**/*.{swift,h,m}'
  s.ios.deployment_target = '13.0'
  s.dependency 'Capacitor'
  s.swift_version = '5.1'
end
