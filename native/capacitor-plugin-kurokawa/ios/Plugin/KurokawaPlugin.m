#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

CAP_PLUGIN(KurokawaPlugin, "Kurokawa",
  CAP_PLUGIN_METHOD(pickTree, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(listTree, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(readDocument, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(saveToGallery, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(copyImage, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(deviceInfo, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(setBrightness, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(getBrightness, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(httpRequest, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(openWebView, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(browserFetch, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(browserReset, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(browserForget, CAPPluginReturnPromise);
  CAP_PLUGIN_METHOD(printToPdf, CAPPluginReturnPromise);
)
