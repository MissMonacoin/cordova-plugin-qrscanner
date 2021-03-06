require('webrtc-adapter');
var workerScript = require("raw-loader!../worker.min.js");

module.exports = function(){

  var ELEMENTS = {
    preview: 'cordova-plugin-qrscanner-video-preview',
    still: 'cordova-plugin-qrscanner-still'
  };
  var ZINDEXES = {
    preview: -100,
    still: -99
  };
  var backCamera = null;
  var frontCamera = null;
  var currentCamera = 0;
  var activeMediaStream = null;
  var scanning = false;
  var previewing = false;
  var scanWorker = null;
  var thisScanCycle = null;
  var nextScan = null;
  var cancelNextScan = null;
  var snapshotCanvas = null;
  var snapshotCanvasContext = null;

  // standard screen widths/heights, from 4k down to 320x240
  // widths and heights are each tested separately to account for screen rotation
  var standardWidthsAndHeights = [
    2560, 2048, 2000, 1920,
    1600, 1536, 1440,
    1280, 1080, 1024, 960, 854, 848,
    720, 640, 600, 540, 512, 480, 320, 240
  ];

  var facingModes = [
    'environment',
    'user'
  ];

  //utils
  function killStream(mediaStream){
    mediaStream.getTracks().forEach(function(track){
      track.stop();
    });
  }

  // For performance, we test best-to-worst constraints. Once we find a match,
  // we move to the next test. Since `ConstraintNotSatisfiedError`s are thrown
  // much faster than streams can be started and stopped, the scan is much
  // faster, even though it may iterate through more constraint objects.
  function getCameraSpecsById(deviceId){

    // return a getUserMedia Constraints
    function getConstraintObj(deviceId, facingMode, width, height){
      var obj = { audio: false, video: {} };
      obj.video.deviceId = {exact: deviceId};
      if(facingMode) {
        obj.video.facingMode = {exact: facingMode};
      }
      if(width) {
        obj.video.width = {exact: width};
      }
      if(height) {
        obj.video.height = {exact: height};
      }
      return obj;
    }

    var facingModeConstraints = facingModes.map(function(mode){
    	return getConstraintObj(deviceId, mode);
    });
    var widthConstraints = standardWidthsAndHeights.map(function(width){
    	return getConstraintObj(deviceId, null, width);
    });
    var heightConstraints = standardWidthsAndHeights.map(function(height){
    	return getConstraintObj(deviceId, null, null, height);
    });

    // create a promise which tries to resolve the best constraints for this deviceId
    // rather than reject, failures return a value of `null`
    function getFirstResolvingConstraint(constraintsBestToWorst){
      return new Promise(function(resolveBestConstraints){
        // build a chain of promises which either resolves or continues searching
        return constraintsBestToWorst.reduce(function(chain, next){
          return chain.then(function(searchState){
            if(searchState.found){
              // The best working constraint was found. Skip further tests.
              return searchState;
            } else {
              searchState.nextConstraint = next;
              return window.navigator.mediaDevices.getUserMedia(searchState.nextConstraint).then(function(mediaStream){
                // We found the first working constraint object, now we can stop
                // the stream and short-circuit the search.
                killStream(mediaStream);
                searchState.found = true;
                return searchState;
              }, function(){
                // didn't get a media stream. The search continues:
                return searchState;
              });
            }
          });
        }, Promise.resolve({
          // kick off the search:
          found: false,
          nextConstraint: {}
        })).then(function(searchState){
          if(searchState.found){
            resolveBestConstraints(searchState.nextConstraint);
          } else {
            resolveBestConstraints(null);
          }
        });
      });
    }

    return getFirstResolvingConstraint(facingModeConstraints).then(function(facingModeSpecs){
      return getFirstResolvingConstraint(widthConstraints).then(function(widthSpecs){
        return getFirstResolvingConstraint(heightConstraints).then(function(heightSpecs){
          return {
            deviceId: deviceId,
            facingMode: facingModeSpecs === null ? null : facingModeSpecs.video.facingMode.exact,
            width: widthSpecs === null ? null : widthSpecs.video.width.exact,
            height: heightSpecs === null ? null : heightSpecs.video.height.exact
          };
        });
      });
    });
  }

  function chooseCameras(){
    var devices = window.navigator.mediaDevices.enumerateDevices();
    return devices.then(function(mediaDeviceInfoList){
      var videoDeviceIds = mediaDeviceInfoList.filter(function(elem){
        return elem.kind === 'videoinput';
      }).map(function(elem){
        return elem.deviceId;
      });
      return videoDeviceIds;
    }).then(function(videoDeviceIds){
      // there is no standardized way for us to get the specs of each camera
      // (due to concerns over user fingerprinting), so we're forced to
      // iteratively test each camera for it's capabilities
      var searches = [];
      videoDeviceIds.forEach(function(id){
        searches.push(getCameraSpecsById(id));
      });
      return Promise.all(searches);
    }).then(function(cameraSpecsArray){
      return cameraSpecsArray.filter(function(camera){
        // filter out any cameras where width and height could not be captured
        if(camera !== null && camera.width !== null && camera.height !== null){
          return true;
        }
      }).sort(function(a, b){
        // sort cameras from highest resolution (by width) to lowest
        return b.width - a.width;
      });
    }).then(function(bestToWorstCameras){
      var backCamera = null,
          frontCamera = null;
      // choose backCamera
      for(var i = 0; i < bestToWorstCameras.length; i++){
        if (bestToWorstCameras[i].facingMode === 'environment'){
          backCamera = bestToWorstCameras[i];
          // (shouldn't be used for frontCamera)
          bestToWorstCameras.splice(i, 1);
          break;
        }
      }
      // if no back-facing cameras were found, choose the highest resolution
      if(backCamera === null){
        if(bestToWorstCameras.length > 0){
          backCamera = bestToWorstCameras[0];
          // (shouldn't be used for frontCamera)
          bestToWorstCameras.splice(0, 1);
        } else {
          // user doesn't have any available cameras
          backCamera = false;
        }
      }
      if(bestToWorstCameras.length > 0){
        // frontCamera should simply be the next-best resolution camera
        frontCamera = bestToWorstCameras[0];
      } else {
        // user doesn't have any more cameras
        frontCamera = false;
      }
      return {
        backCamera: backCamera,
        frontCamera: frontCamera
      };
    });
  }

  function mediaStreamIsActive(){
    return activeMediaStream !== null;
  }

  function killActiveMediaStream(){
    killStream(activeMediaStream);
    activeMediaStream = null;
  }

  function getVideoPreview(){
    return document.getElementById(ELEMENTS.preview);
  }

  function getImg(){
    return document.getElementById(ELEMENTS.still);
  }

  function getCurrentCameraIndex(){
    return currentCamera;
  }

  function getCurrentCamera(){
    return currentCamera === 1 ? frontCamera : backCamera;
  }

  function bringStillToFront(){
    var img = getImg();
    if(img){
      img.style.visibility = 'visible';
      previewing = false;
    }
  }

  function bringPreviewToFront(){
    var img = getImg();
    if(img){
      img.style.visibility = 'hidden';
      previewing = true;
    }
  }

  function isInitialized(){
    return backCamera !== null;
  }

  function canChangeCamera(){
    return !!backCamera && !!frontCamera;
  }

  function calcStatus(){
    return {
      // !authorized means the user either has no camera or has denied access.
      // This would leave a value of `null` before prepare(), and `false` after.
      authorized: (backCamera !== null && backCamera !== false)? '1': '0',
      // No applicable API
      denied: '0',
      // No applicable API
      restricted: '0',
      prepared: isInitialized() ? '1' : '0',
      scanning: scanning? '1' : '0',
      previewing: previewing? '1' : '0',
      // We leave this true after prepare() to match the mobile experience as
      // closely as possible. (Without additional covering, the preview will
      // always be visible to the user).
      showing: getVideoPreview()? '1' : '0',
      // No applicable API
      lightEnabled: '0',
      // No applicable API
      canOpenSettings: '0',
      // No applicable API
      canEnableLight: '0',
      canChangeCamera: canChangeCamera() ? '1' : '0',
      currentCamera: currentCamera.toString()
    };
  }

  function startCamera(success, error){
      var currentCameraIndex = getCurrentCameraIndex();
      var currentCamera = getCurrentCamera();
      window.navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          deviceId: {exact: currentCamera.deviceId},
          width: {ideal: currentCamera.width},
          height: {ideal: currentCamera.height}
        }
      }).then(function(mediaStream){
        activeMediaStream = mediaStream;
        var video = getVideoPreview();

        // Newer browsers have deprecated `video.src`, so we attempt video.srcObject
        // first, and then fall back to video.src if that's not supported,
        // as per https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/srcObject#Supporting_fallback_to_the_src_property
        try {
          video.srcObject = mediaStream;
        } catch(error) {
          video.src = URL.createObjectURL(mediaStream);
        }

        success(calcStatus());
      }, function(err){
        // something bad happened
        err = null;
        var code = currentCameraIndex? 4 : 3;
        error(code); // FRONT_CAMERA_UNAVAILABLE : BACK_CAMERA_UNAVAILABLE
      });
  }

  function updateSnapshotCanvas(videoElement){
    // Use the dimensions of the on-screen display, not the camera dimensions.
    //
    // Since we're snapshotting the content of the html element into an image,
    // we want the width/height to reflect the current rotation of the html
    // element. Without this, we can run into issues where the image is
    // vertically squashed.
    var width = videoElement.clientWidth;
    var height = videoElement.clientHeight;

    // Force the canvas to match the underlying video presentation element,
    // to handle cases where the device has changed rotation since the last snapshot
    snapshotCanvas.width = width;
    snapshotCanvas.height = height;

    snapshotCanvasContext.drawImage(videoElement, 0, 0, width, height);
  }

  function getCurrentImageData(videoElement){
    updateSnapshotCanvas(videoElement);

    return snapshotCanvasContext.getImageData(0, 0, snapshotCanvas.width, snapshotCanvas.height);
  }

  // take a screenshot of the video preview with a temp canvas
  function captureCurrentFrame(videoElement){
    updateSnapshotCanvas(videoElement);

    return snapshotCanvas.toDataURL('image/png');
  }

  function initialize(success, error){
    if(scanWorker === null){
      var workerBlob = new Blob([workerScript],{type: "text/javascript"});
      scanWorker = new Worker(URL.createObjectURL(workerBlob));
    }

    // Create only one in-memory canvas, otherwise memory leaks can lead to
    // hundreds of canvases, which then causes the browser to run out of
    // canvas memory
    if(snapshotCanvas === null){
      snapshotCanvas = document.createElement('canvas');
      snapshotCanvasContext = snapshotCanvas.getContext('2d');
    }

    if(!getVideoPreview()){
      // prepare DOM (sync)
      var videoPreview = document.createElement('video');
      videoPreview.setAttribute('autoplay', 'autoplay');
      videoPreview.setAttribute('playsinline', 'playsinline');
      videoPreview.setAttribute('muted', 'muted');
      videoPreview.setAttribute('id', ELEMENTS.preview);
      videoPreview.setAttribute('style', 'display:block;position:fixed;' +
      'width:100%;height:100%;z-index:' + ZINDEXES.preview +
      ';background-color:#000;');
      videoPreview.addEventListener('loadeddata', function(){
        bringPreviewToFront();
      });

      var stillImg = document.createElement('div');
      stillImg.setAttribute('id', ELEMENTS.still);
      videoPreview.setAttribute('style', 'display:block;position:fixed;' +
      'width:100%;height:100%;z-index:' + ZINDEXES.preview +
      ';background-color:#000;');

      document.body.appendChild(videoPreview);
      document.body.appendChild(stillImg);
    }
    if(backCamera === null){
      // set instance cameras
      chooseCameras().then(function(cameras){
        backCamera = cameras.backCamera;
        frontCamera = cameras.frontCamera;
        if(backCamera !== false){
          success();
        } else {
          error(5); // CAMERA_UNAVAILABLE
        }
      }, function(err){
        // something bad happened
        err = null;
        error(0); // UNEXPECTED_ERROR
      });
    } else if (backCamera === false){
      error(5); // CAMERA_UNAVAILABLE
    } else {
      success();
    }
  }

  /*
   *  --- Begin Public API ---
   */

  function prepare(success, error){
    initialize(function(){
      // return status on success
      success(calcStatus());
    },
    // pass errors through
    error);
  }

  function show(success, error){
    function showCamera(){
      if(!mediaStreamIsActive()){
        startCamera(success, error);
      } else {
        success(calcStatus());
      }
    }
    if(!isInitialized()){
      initialize(function(){
        // on successful initialization, attempt to showCamera
        showCamera();
      },
      // pass errors through
      error);
    } else {
      showCamera();
    }
  }

  function hide(success, error){
    error = null; // should never error
    if(mediaStreamIsActive()){
      killActiveMediaStream();
    }
    var video = getVideoPreview();
    if(video){
      video.src = '';
      video.srcObject = null;
    }
    success(calcStatus());
  }

  function scan(success, error) {
    // initialize and start video preview if not already active
    show(function(ignore){
      // ignore success output – `scan` method callback should be passed the decoded data
      ignore = null;
      var video = getVideoPreview();
      var returned = false;
      scanning = true;
      scanWorker.onmessage = function(event){
        var obj = event.data;
        if(obj.result && !returned){
          returned = true;
          thisScanCycle = null;
          success(obj.result);
        }
      };
      thisScanCycle = function(){
        var imageData = getCurrentImageData(video);
        // imageData may be null if we have run out of canvas memory
        if (imageData){
          scanWorker.postMessage(imageData);
        }
        if(cancelNextScan !== null){
          // avoid race conditions, always clear before starting a cycle
          cancelNextScan();
        }
        // interval in milliseconds at which to try decoding the QR code
        var SCAN_INTERVAL = window.QRScanner_SCAN_INTERVAL || 130;
        // this value can be adjusted on-the-fly (while a scan is active) to
        // balance scan speed vs. CPU/power usage
        nextScan = window.setTimeout(thisScanCycle, SCAN_INTERVAL);
        cancelNextScan = function(sendError){
          window.clearTimeout(nextScan);
          nextScan = null;
          cancelNextScan = null;
          if(sendError){
            error(6); // SCAN_CANCELED
          }
        };
      };
      thisScanCycle();
    }, error);
  }

  function cancelScan(success, error){
    error = null; // should never error
    if(cancelNextScan !== null){
      cancelNextScan(true);
    }
    scanning = false;
    if(typeof success === "function"){
      success(calcStatus());
    }
  }

  function pausePreview(success, error){
    error = null; // should never error
    if(mediaStreamIsActive()){
      // pause scanning too
      if(cancelNextScan !== null){
        cancelNextScan();
      }
      var video = getVideoPreview();
      video.pause();
      var img = new Image();
      img.src = captureCurrentFrame(video);
      getImg().style.backgroundImage = 'url(' + img.src + ')';
      bringStillToFront();
      // kill the active stream to turn off the privacy light (the screenshot
      // in the stillImg will remain visible)
      killActiveMediaStream();
      success(calcStatus());
    } else {
      success(calcStatus());
    }
  }

  function resumePreview(success, error){
    // if a scan was happening, resume it
    if(thisScanCycle !== null){
      thisScanCycle();
    }
    show(success, error);
  }

  function enableLight(success, error){
    error(7); //LIGHT_UNAVAILABLE
  }

  function disableLight(success, error){
    error(7); //LIGHT_UNAVAILABLE
  }

  function useCamera(success, error, array){
    var requestedCamera = array[0];
    var initialized = isInitialized();
    if(requestedCamera !== currentCamera){
      if(initialized && requestedCamera === 1 && !canChangeCamera()){
          error(4); //FRONT_CAMERA_UNAVAILABLE
      } else {
        currentCamera = requestedCamera;
        if(initialized){
          hide(function(status){
            // Don't need this one
            status = null;
          });
          show(success, error);
        } else {
          success(calcStatus());
        }
      }
    } else {
      success(calcStatus());
    }
  }

  function openSettings(success, error){
    error(8); //OPEN_SETTINGS_UNAVAILABLE
  }

  function getStatus(success, error){
    error = null; // should never error
    success(calcStatus());
  }

  // Reset all instance variables to their original state.
  // This method might be useful in cases where a new camera is available, and
  // the application needs to force the plugin to chooseCameras() again.
  function destroy(success, error){
    error = null; // should never error
    cancelScan();
    if(mediaStreamIsActive()){
      killActiveMediaStream();
    }
    backCamera = null;
    frontCamera = null;
    var preview = getVideoPreview();
    var still = getImg();
    if(preview){
      preview.remove();
    }
    if(still){
      still.remove();
    }
    success(calcStatus());
  }

  return {
      prepare: prepare,
      show: show,
      hide: hide,
      scan: scan,
      cancelScan: cancelScan,
      pausePreview: pausePreview,
      resumePreview: resumePreview,
      enableLight: enableLight,
      disableLight: disableLight,
      useCamera: useCamera,
      openSettings: openSettings,
      getStatus: getStatus,
      destroy: destroy
  };
};
