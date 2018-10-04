import {parseURL} from '../utils'
import {EventEmitter} from 'events'
import {noop, defaults} from '../utils/lodash'
import {NODE_STATUS} from '../utils'
import {multi} from 'event-to-promise'

const Redis = require('../redis')
const debug = require('../utils/debug')('ioredis:cluster:connectionPool')
const maxInt = 2147483647
const resolveStatus = [NODE_STATUS.WAIT, NODE_STATUS.CONNECT, NODE_STATUS.READY, NODE_STATUS.END]

type NODE_TYPE = 'all' | 'master' | 'slave'

interface IRedisOptions {
  [key: string]: any
}

interface IRedisOptionsWithKey extends IRedisOptions {
  key: string
}

export default class ConnectionPool extends EventEmitter {
  // master + slave = all
  private nodes: {[key in NODE_TYPE]: {[key: string]: any}} = {
    all: {},
    master: {},
    slave: {}
  }

  private specifiedOptions: {[key: string]: any} = {}
  private ready: boolean = false
  private iteration: number = 0

  constructor (private redisOptions) {
    super()
  }

  /**
   * Find or create a connection to the node
   *
   * @param {IRedisOptions} node
   * @param {boolean} [readOnly=false]
   * @returns {*}
   * @memberof ConnectionPool
   */
  public findOrCreate (node: IRedisOptions, readOnly: boolean = false): any {
    setKey(node)
    readOnly = Boolean(readOnly)

    if (this.specifiedOptions[node.key]) {
      Object.assign(node, this.specifiedOptions[node.key])
    } else {
      this.specifiedOptions[node.key] = node
    }

    let redis
    if (this.nodes.all[node.key]) {
      redis = this.nodes.all[node.key]
      if (redis.options.readOnly !== readOnly) {
        redis.options.readOnly = readOnly
        debug('Change role of %s to %s', node.key, readOnly ? 'slave' : 'master')
        redis[readOnly ? 'readonly' : 'readwrite']().catch(noop)
        if (readOnly) {
          delete this.nodes.master[node.key]
          this.nodes.slave[node.key] = redis
        } else {
          delete this.nodes.slave[node.key]
          this.nodes.master[node.key] = redis
        }
      }
    } else {
      debug('Connecting to %s as %s', node.key, readOnly ? 'slave' : 'master')
      redis = new Redis(defaults({
        // Never try to reconnect when a node is lose,
        // instead, waiting for a `MOVED` error and
        // fetch the slots again.
        retryStrategy: null,
        // Offline queue should be enabled so that
        // we don't need to wait for the `ready` event
        // before sending commands to the node.
        enableOfflineQueue: true,
        readOnly: readOnly
      }, node, this.redisOptions, { lazyConnect: true }))

      const role = readOnly ? 'slave' : 'master'
      this.nodes.all[node.key] = redis
      this.nodes[role][node.key] = redis

      redis.once(NODE_STATUS.END, () => {
        delete this.nodes.all[node.key]
        delete this.nodes.master[node.key]
        delete this.nodes.slave[node.key]

        this.emit('-node', redis)
        if (!Object.keys(this.nodes.all).length) {
          this.emit('drain')
        }
      })

      this.emit('+node', redis)

      redis.on('error', function (error) {
        this.emit('nodeError', error)
      })
    }

    return redis
  }

  /**
   * Reset the pool with a set of nodes.
   * The old node will be removed.
   *
   * @param {(Array<string | number | object>)} nodes
   * @memberof ConnectionPool
   */
  public reset (nodes: Array<string | number | object>): void {
    this.ready = false
    this.iteration = (this.iteration + 1) & maxInt
    const newNodes = {}
    nodes.forEach((node) => {
      const options: {port?: number | string, db?: number, key?: string} = {}
      if (typeof node === 'object') {
        defaults(options, node)
      } else if (typeof node === 'string') {
        defaults(options, parseURL(node))
      } else if (typeof node === 'number') {
        options.port = node
      } else {
        throw new Error('Invalid argument ' + node)
      }
      if (typeof options.port === 'string') {
        options.port = parseInt(options.port, 10)
      }
      delete options.db

      setKey(options)
      newNodes[options.key] = options
    }, this)

    Object.keys(this.nodes.all).forEach((key) => {
      if (!newNodes[key]) {
        debug('Disconnect %s because the node does not hold any slot', key)
        this.nodes.all[key].disconnect()
      }
    })

    const iteration = this.iteration
    const track = Object.keys(newNodes).map((key) => {
      const node = newNodes[key]
      const redis = this.findOrCreate(node, node.readOnly)

      if (resolveStatus.indexOf(redis.status) >= 0) {
        return null
      }

      return multi(redis, resolveStatus, [])
    })

    Promise.all(track).then(() => {
      if (this.iteration !== iteration) return

      this.ready = true
      this.emit('+all')
    })
  }

  public onReady (handler: () => any): void {
    if (this.ready) {
      handler()
      return
    }

    this.once('+all', handler)
  }
}

/**
 * Set key property
 *
 * @private
 */
function setKey(node: IRedisOptions): IRedisOptionsWithKey {
  node = node || {}
  node.port = node.port || 6379
  node.host = node.host || '127.0.0.1'
  node.key = node.key || node.host + ':' + node.port
  return <IRedisOptionsWithKey>node
}
