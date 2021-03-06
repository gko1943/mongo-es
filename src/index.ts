#!/usr/bin/env node

import 'source-map-support/register'
import { parse, format } from 'url'
import { readFile } from 'fs'
import { resolve as resolvePath } from 'path'
import { forEach, map, compact, isNil } from 'lodash'
import { Observable } from 'rx'
import { scan, tail } from './extract'
import { document, oplog } from './transform'
import { bulk, exists, putMapping, create } from './load'
import { Task, Config, Controls, IntermediateRepresentation, ObjectID } from './types'
import { init } from './models'
import { taskName } from './utils'

const defaults = {
  mongodbReadCapacity: 10000,
  elasticsearchBulkSize: 5000,
  maxID: 'FFFFFFFFFFFFFFFFFFFFFFFF',
}

async function readConfig(path: string): Promise<Config> {
  return new Promise<Config>((resolve, reject) => {
    readFile(resolvePath(path), 'utf8', (err, str) => {
      err ? reject(err) : resolve(JSON.parse(str))
    })
  })
}

async function scanDocument(controls: Controls, task: Task, index: number, id: ObjectID): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    scan(task.extract, id, controls.mongodbReadCapacity || defaults.mongodbReadCapacity)
      .bufferWithTimeOrCount(1000, controls.elasticsearchBulkSize || defaults.elasticsearchBulkSize)
      .subscribe(async (docs) => {
        if (docs.length === 0) {
          return
        }
        try {
          await bulk(task.load, compact<any>(map(docs, doc => document(task, doc))))
          console.log('scan', taskName(task), docs.length, docs[0]._id.toHexString())
        } catch (err) {
          console.warn('scan', taskName(task), err.message)
        }
      }, reject, resolve)
  })
}

async function tailOpLog(controls: Controls, task: Task, index: number, from: Date): Promise<never> {
  return new Promise<never>((resolve) => {
    tail(task.extract, from)
      .bufferWithTimeOrCount(1000, 50)
      .flatMap((logs) => {
        return Observable.create<IntermediateRepresentation>(async (observer) => {
          for (let log of logs) {
            const doc = await oplog(task, log)
            if (doc) {
              observer.onNext(doc)
            }
          }
        })
      })
      .bufferWithTimeOrCount(1000, controls.elasticsearchBulkSize || defaults.elasticsearchBulkSize)
      .subscribe(async (docs) => {
        if (docs.length === 0) {
          return
        }
        try {
          await bulk(task.load, docs)
          console.log('tail', taskName(task), docs.length)
        } catch (err) {
          console.warn('tail', taskName(task), err.message)
        }
      }, (err) => {
        const oneMinuteAgo = new Date()
        oneMinuteAgo.setMinutes(oneMinuteAgo.getMinutes() - 1)
        console.error('tail', taskName(task), err)
        return tailOpLog(controls, task, index, oneMinuteAgo)
      }, () => {
        console.error('tail', taskName(task), 'should not complete')
        resolve()
      })
  })
}

async function runTask(config: Config, task: Task, index: number) {
  const from = isNil(task.from.time) ? new Date() : new Date(task.from.time)
  if (task.from.phase === 'scan') {
    try {
      console.log('scan', taskName(task), 'start', 'from', task.from.id || defaults.maxID)
      await scanDocument(config.controls, task, index, new ObjectID(task.from.id || defaults.maxID))
      console.log('scan', taskName(task), 'end')
    } catch (err) {
      console.error('scan', err)
    }
  }
  console.log('tail', taskName(task), 'start', 'from', from)
  await tailOpLog(config.controls, task, index, from)
}

(async function run() {
  try {
    const config = await readConfig(process.argv[2])
    console.debug(JSON.stringify(config, null, 2))

    await init(config)
    console.log('run', new Date())

    for (let index of config.elasticsearch.indices || []) {
      index.index += config.controls.indexNameSuffix || ''
      if (!await exists(index.index)) {
        await create(index)
        console.log('create index', index.index)
      }
    }

    for (let index in config.tasks) {
      const task = config.tasks[index]
      task.load.index += config.controls.indexNameSuffix || ''
      await putMapping(task.load)
      console.log('put mapping', task.load.index, task.load.type)
    }

    forEach(config.tasks, (task, index) => {
      runTask(config, task, index)
    })
  } catch (err) {
    console.error('run', err)
  }
})()

console.debug = process.env.NODE_ENV === 'dev' ? console.log : () => null
