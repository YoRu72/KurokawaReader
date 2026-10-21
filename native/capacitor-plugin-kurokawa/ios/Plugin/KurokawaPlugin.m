#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

CAP_PLUGIN(KurokawaPlugin, "Kurokawa",
  CAP_PLUGIN_METHOD(pickTree, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(listTree, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(readDocument, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(saveToGallery, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(copyImage, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(deviceInfo, CAPPluginReturnPromise);
)
