import * as errors from './errors';
import * as messages from './messages';
import promiseCoalescer from './promiseCoalescer';

const jsonContentType = 'application/json';

function getResponseError(result) {
  if (result.status === 404) {
    return new errors.ULInvalidEnvironmentIdError(messages.environmentNotFound());
  } else {
    return new errors.ULFlagFetchError(messages.errorFetchingFlags(result.statusText || String(result.status)));
  }
}

export default function Requestor(platform, options, environment) {
  const baseUrl = options.host;
  const requestor = {};

  const activeRequests = {}; // map of URLs to promiseCoalescers

  function fetchJSON(endpoint, body) {
    
    if (!platform.httpRequest) {
      return new Promise((resolve, reject) => {
        reject(new errors.ULFlagFetchError(messages.httpUnavailable()));
      });
    }

    const method = body ? 'POST' : 'GET';
    const headers = {}
    
    if (body) {
      headers['Content-Type'] = jsonContentType;
      headers['X-Api-Key'] = environment;
    }

    let coalescer = activeRequests[endpoint];
    if (!coalescer) {
      coalescer = promiseCoalescer(() => {
        // this will be called once there are no more active requests for the same endpoint
        delete activeRequests[endpoint];
      });
      activeRequests[endpoint] = coalescer;
    }
    const req = platform.httpRequest(method, endpoint, headers, body);
    const p = req.promise.then(
      result => {
        if (result.status === 200) {
          // We're using substring here because using startsWith would require a polyfill in IE.
          if (
            result.header('content-type') &&
            result.header('content-type').substring(0, jsonContentType.length) === jsonContentType
          ) {
            return JSON.parse(result.body);
          } else {
            const message = messages.invalidContentType(result.header('content-type') || '');
            return Promise.reject(new errors.ULFlagFetchError(message));
          }
        }
        else if (result.status === 400) {
          if (
              result.header('content-type') &&
              result.header('content-type').substring(0, jsonContentType.length) === jsonContentType
          ) {
            return Promise.reject(new errors.ULInvalidArgumentError(result.body));
          } else {
            const message = messages.invalidContentType(result.header('content-type') || '');
            return Promise.reject(new errors.ULFlagFetchError(message));
          }
        }
        else {
          return Promise.reject(getResponseError(result));
        }
      },
      e => Promise.reject(new errors.ULFlagFetchError(messages.networkError(e)))
    );
    coalescer.addPromise(p, () => {
      // this will be called if another request for the same endpoint supersedes this one
      req.cancel && req.cancel();
    });
    return coalescer.resultPromise;
  }

  // Performs a GET request to an arbitrary path under baseUrl. Returns a Promise which will resolve
  // with the parsed JSON response, or will be rejected if the request failed.
  requestor.fetchJSON = function(path) {
    return fetchJSON(baseUrl + path, null);
  };

  requestor.fetchFlagsWithResult = function(user, flagKeys) {
    
    let endpoint = [baseUrl, '/evaluate'].join('') + '?evaluationReason=' + options.evaluationReason;
    
    let body = getRequestBody(flagKeys, user);
    
    body = JSON.stringify(body);
        
    return fetchJSON(endpoint, body);
  };

  function getRequestBody(flagKeys, user) {
    let requestUser = {};

    requestUser.attributes = {};
    requestUser.flagKeys = [];

    requestUser.flagKeys = flagKeys.toString();

    requestUser.id = user.identity || _getUUIDv4();

    let attributes = user.attributes;
    for (const attr in attributes) {
        requestUser.attributes[attr] = attributes[attr];
    }
  
    return requestUser;
  };

  function _getUUIDv4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      const r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  return requestor;
}
