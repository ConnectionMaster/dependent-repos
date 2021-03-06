#!/usr/bin/env node

require('dotenv-safe').load()

const fs = require('fs')
const csv = require('csv-parser')
const db = require('../lib/db')
const ellipsize = require('ellipsize')
const coolStory = require('cool-story-repo')
const Bottleneck = require('bottleneck')
const limiter = new Bottleneck({
  maxConcurrent: 5,
  minTime: 500
})

const repoNames = []
const freshRepos = []
const deadRepos = []
const jobStartTime = Date.now()

const JOB_DURATION = 3000000 // 50 minutes
const REPO_TTL = 2592000000 // 30 days

fs.createReadStream('dependent-repos.csv')
  .pipe(csv())
  .on('data', function (data) {
    repoNames.push(data['Repository Name with Owner'])
  })
  .on('end', triageExistingData)

function triageExistingData () {
  db.createReadStream()
    .on('data', ({key: repoName, value: repo}) => {
      if (!repo) return
      if (repo.status === 404) { deadRepos.push(repoName); return }
      if (!repo.fetchedAt) return
      if (new Date(repo.fetchedAt).getTime() + REPO_TTL < Date.now()) return
      freshRepos.push(repoName)
    })
    .on('end', collectFreshData)
}

function collectFreshData () {
  const reposToUpdate = repoNames
    .filter(repoName => !freshRepos.includes(repoName) && !deadRepos.includes(repoName))

  console.log(`${repoNames.length} total repos dependent on electron`)
  console.log(`${freshRepos.length} up-to-date repos in database (last ${REPO_TTL})`)
  console.log(`${deadRepos.length} dead repos in database`)
  console.log(`${reposToUpdate.length} outdated or not-yet-fetched repos`)
  console.log('---------------------------------------')

  reposToUpdate.forEach(repoName => {
    limiter.schedule(updateRepo, repoName)
  })

  limiter
    .on('idle', () => {
      console.log('done')
      process.exit()
    })
    .on('error', (err) => {
      console.log('bottleneck error', err)
      process.exit()
    })
}

async function updateRepo (repoName) {
  if (Date.now() > jobStartTime + JOB_DURATION) {
    console.log('time is up! exiting')
    process.exit()
  }

  try {
    const repo = await coolStory(repoName)
    const result = await db.put(repoName, repo)
    console.log(repoName, '(good)')
    return result
  } catch (err) {
    await db.put(repoName, {
      fetchedAt: new Date(),
      status: 404
    })
    console.error(repoName, ellipsize(err.message, 60))
  }
}
