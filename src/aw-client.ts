import axios, { AxiosInstance, AxiosError } from 'axios';

// Default interfaces for events and heartbeats
export interface Heartbeat {
    id?: number;
    timestamp: Date;
    duration?: number;    // duration in seconds
    data: { [k: string]: any };
}
export interface Event extends Heartbeat {
    duration: number;
}

// Interfaces for coding activity
export interface AppEditorActivityHeartbeat extends Heartbeat {
    data: {
        project: string;    // Path to the current project / workDir
        file: string;       // Path to the current file
        language: string;   // Coding Language identifier (e.g. javascript, python, ...)
        [k: string]: any;   // Additional (custom) data
    }
}
export interface AppEditorActivityEvent extends AppEditorActivityHeartbeat {
    duration: number;
}

export interface Bucket {
  id: string,
  name: string,
  type: string,
  client: string,
  hostname: string,
  created: Date
  last_update?: Date
}

interface HeartbeatQueueItem {
    onSuccess: (heartbeat: Heartbeat) => void;
    onError: (err: AxiosError) => void;
    pulsetime: number;
    heartbeat: Heartbeat;
}

export class AWClient {
    public clientname: string;
    public baseURL: string;
    public testing: boolean;
    public req: AxiosInstance;

    private heartbeatQueues: {
        [bucket_id: string]: {
            isProcessing: boolean;
            data: Array<HeartbeatQueueItem>
        }
    } = {};

    constructor(clientname: string, options: {testing?: boolean, baseURL?: string} = {}) {
        this.clientname = clientname;
        this.testing = options.testing || false;
        if (typeof options.baseURL === 'undefined') {
            const port = !options.testing ? 5600 : 5666;
            this.baseURL = 'http://127.0.0.1:' + port;
        } else {
          this.baseURL = options.baseURL;
        }


        this.req = axios.create({
            baseURL: this.baseURL + '/api',
            timeout: 10000,
        });
    }

    getInfo(): Promise<{
      hostname: string,
      version: string,
      testing: boolean
    }> {
        return this.req.get('/0/info').then(res => res.data);
    }

    ensureBucket(bucketId: string, type: string, hostname: string): Promise<{ alreadyExist: boolean }> {
      return this.req.post('/0/buckets/' + bucketId, {
          client: this.clientname,
          type,
          hostname,
      }).then(() => ({alreadyExist: false})).catch(err => {
        // Will return 304 if bucket already exists
        if (err && err.response && err.response.status == 304) {
          return {alreadyExist: true};
        }
        throw err
      });
  }

    createBucket(bucketId: string, type: string, hostname: string) {
        return this.req.post('/0/buckets/' + bucketId, {
            client: this.clientname,
            type,
            hostname,
        }).then(() => undefined);
    }

    deleteBucket(bucketId: string) {
        return this.req.delete('/0/buckets/' + bucketId + "?force=1").then(() => undefined);
    }

    getBuckets(): Promise<{[bucketId: string]: Bucket}> {
        return this.req.get("/0/buckets/")
        .then(res => res.data)
        .then(buckets => {
          Object.keys(buckets).forEach(bucket => {
            buckets[bucket].created = new Date(buckets[bucket].created)
            if (buckets[bucket].last_updated) {
              buckets[bucket].last_updated = new Date(buckets[bucket].last_updated)
            }
          })
          return buckets
        });
    }

    getBucketInfo(bucketId: string): Promise<Bucket> {
        return this.req.get("/0/buckets/" + bucketId)
        .then(res => res.data)
        .then(bucket => {
          bucket.created = new Date(bucket.created)
          return bucket
        });
    }

    getEvents(bucketId: string, params: { [k: string]: any }): Promise<Array<Event>> {
        return this.req.get("/0/buckets/" + bucketId + "/events", { params }).then(res => res.data)
        .then(events => {
          events.forEach((event: Event) => {
            event.timestamp = new Date(event.timestamp)
          })
          return events
        });
    }

    countEvents(bucketId: string, startTime?: Date, endTime?: Date) {
        const params = {
            starttime: startTime ? startTime.toISOString() : null,
            endtime: endTime ? endTime.toISOString() : null,
        };
        return this.req.get("/0/buckets/" + bucketId + "/events/count", { params });
    }

    insertEvent(bucketId: string, event: Event) {
        return this.insertEvents(bucketId, [event]).then(events => events[0]);
    }

    insertEvents(bucketId: string, events: Array<Event>): Promise<Array<Event>> {
        return this.req.post('/0/buckets/' + bucketId + "/events", events)
        .then(res => res.data)
        .then(events => {
          if (!Array.isArray(events)) {
            events = [events]
          }
          events.forEach((event: Event) => {
            event.timestamp = new Date(event.timestamp)
          })
          return events
        });
    }

    /**
     *
     * @param bucketId The id of the bucket to send the heartbeat to
     * @param pulsetime The maximum amount of time in seconds since the last heartbeat to be merged with the previous heartbeat in aw-server
     * @param heartbeat The actual heartbeat event
     */
    heartbeat(bucketId: string, pulsetime: number, heartbeat: Heartbeat): Promise<Heartbeat> {
        // Create heartbeat queue for bucket if not already existing
        if (!this.heartbeatQueues.hasOwnProperty(bucketId)) {
            this.heartbeatQueues[bucketId] = {
                isProcessing: false,
                data: []
            };
        }

        return new Promise((resolve, reject) => {
            // Add heartbeat request to queue
            this.heartbeatQueues[bucketId].data.push({
                onSuccess: resolve,
                onError: reject,
                pulsetime,
                heartbeat
            });

            this.updateHeartbeatQueue(bucketId);
        });
    }

    private send_heartbeat(bucketId: string, pulsetime: number, data: Heartbeat): Promise<Heartbeat> {
        return this.req.post('/0/buckets/' + bucketId + "/heartbeat?pulsetime=" + pulsetime, data)
        .then(res => res.data)
        .then(heartbeat => {
          heartbeat.timestamp = new Date(heartbeat.timestamp)
          return heartbeat
        });
    }

    // Start heartbeat queue processing if not currently processing
    private updateHeartbeatQueue(bucketId: string) {
        const queue = this.heartbeatQueues[bucketId];

        if (!queue.isProcessing && queue.data.length) {
            const { pulsetime, heartbeat, onSuccess, onError } = queue.data.shift() as HeartbeatQueueItem;

            queue.isProcessing = true;
            this.send_heartbeat(bucketId, pulsetime, heartbeat)
                .then((response) => {
                    onSuccess(response);
                    queue.isProcessing = false;
                    this.updateHeartbeatQueue(bucketId);
                })
                .catch((response) => {
                    onError(response);
                    queue.isProcessing = false;
                    this.updateHeartbeatQueue(bucketId);
                });
        }
    }

    async query(timeperiods: Array<string|{start: Date, end: Date}>, query: Array<string>): Promise<any> {
        const data = {
            query,
            timeperiods: timeperiods.map(tp => (typeof tp !== "string" ? `${tp.start.toISOString()}/${tp.end.toISOString()}` : tp))
        };
        return (await this.req.post('/0/query/', data)).data;
    }
}
