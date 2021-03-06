import EventSender from './EventSender';
import VariationCountProcessor from './VariationCountProcessor';
import * as errors from './errors';
import * as messages from './messages';
import * as utils from './utils';

export default function EventProcessor(
  platform,
  options,
  environmentId,
  diagnosticsAccumulator = null,
  emitter = null,
  sender = null
) {
  const processor = {};
  const eventSender = sender || EventSender(platform, environmentId, options);
  const impressionEventsUrl = options.eventsUrl + '/impressions'
  const varCountEventsUrl = options.eventsUrl + '/events'
  const variationCountProcessor = VariationCountProcessor();
  const eventCapacity = options.eventCapacity;
  const flushInterval = options.flushInterval;
  const logger = options.logger;
  let queue = [];
  let disabled = false;
  let enabledLiveTail = false;
  let exceededCapacity = false;
  let flushTimer;

  function addToOutbox(event) {
    if (queue.length < eventCapacity) {
      queue.push(event);
      exceededCapacity = false;
    } else {
      if (!exceededCapacity) {
        exceededCapacity = true;
        logger.warn(messages.eventCapacityExceeded());
      }
      if (diagnosticsAccumulator) {
        // For diagnostic events, we track how many times we had to drop an event due to exceeding the capacity.
        diagnosticsAccumulator.incrementDroppedEvents();
      }
    }
  }

  processor.enqueue = function(event) {
    if (disabled) {
      return;
    }
    if (event.type === 'IMPRESSION'){
      // aggregate variation counts
      variationCountProcessor.incrementVariationCount(event);

      // added in queue for livetail
      if (enabledLiveTail) {
        addToOutbox(event);
      }

      return;
    }

  };

  processor.flush = function() {
    if (disabled) {
      return Promise.resolve();
    }
    const eventsToSend = queue;
   
    if (eventsToSend.length === 0) {
      return Promise.resolve();
    }
    queue = [];
    logger.debug(messages.debugPostingEvents(eventsToSend.length));
    return eventSender.sendEvents(eventsToSend, impressionEventsUrl).then(responseInfo => {
      if (responseInfo) {
        if (responseInfo.status >= 400) {
          logger.error("Error in sending impression events to server. Error code: " + responseInfo.status);
          utils.onNextTick(() => {
            emitter.maybeReportError(
              new errors.ULUnexpectedResponseError(
                messages.httpErrorMessage(responseInfo.status, 'event posting', 'some events were dropped')
              )
            );
          });
        }
      }
    });
  };

  processor.flushVariationCountEvents = function() {
    if (disabled) {
      return Promise.resolve();
    }
    
    const variationCountEvents = variationCountProcessor.getVariationCountEvents();
   
    variationCountProcessor.clearVariationCount();
  
    if (!variationCountEvents || variationCountEvents.length === 0) {
      return Promise.resolve();
    }
    queue = [];
    logger.debug(messages.debugPostingEvents(variationCountEvents.length));
    return eventSender.sendEvents(variationCountEvents, varCountEventsUrl).then(responseInfo => {
      if (responseInfo) {
        if (responseInfo.status >= 400) {
          logger.error("Error in sending variation count events to server. Error code: " + responseInfo.status);
          utils.onNextTick(() => {
            emitter.maybeReportError(
              new errors.ULUnexpectedResponseError(
                messages.httpErrorMessage(responseInfo.status, 'event posting', 'some events were dropped')
              )
            );
          });
        }
      }
    });
  };

  processor.start = function() {
    const flushTick = () => {
      processor.flush();
      processor.flushVariationCountEvents();
      flushTimer = setTimeout(flushTick, flushInterval);
    };
    flushTimer = setTimeout(flushTick, flushInterval);
  };

  processor.stop = function() {
    clearTimeout(flushTimer);
  };

  return processor;
}
