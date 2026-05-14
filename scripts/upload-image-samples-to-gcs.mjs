import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

function fail(message) {
  console.error(`[upload-image-samples] ${message}`)
  process.exit(1)
}

function parseArgs(argv) {
  const out = {
    bucket: '',
    project: '',
    prefix: 'images/samples',
    makePublic: true,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--bucket') out.bucket = (argv[++i] ?? '').trim()
    else if (a === '--project') out.project = (argv[++i] ?? '').trim()
    else if (a === '--prefix') out.prefix = (argv[++i] ?? '').trim() || 'images/samples'
    else if (a === '--no-public') out.makePublic = false
  }
  return out
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: true })
  if (r.status !== 0) {
    fail(`Command failed: ${cmd} ${args.join(' ')}`)
  }
}

const args = parseArgs(process.argv.slice(2))
if (!args.bucket) {
  fail('Missing --bucket <bucket-name>.')
}

const srcDir = resolve('public', 'images', 'samples')
const bucketPath = `gs://${args.bucket}/${args.prefix.replace(/^\/+|\/+$/g, '')}`

const gcloudBase = ['storage']
if (args.project) {
  gcloudBase.push('--project', args.project)
}

console.log(`[upload-image-samples] Uploading ${srcDir} -> ${bucketPath}`)
run('gcloud', [...gcloudBase, 'cp', '--recursive', srcDir, bucketPath])

if (args.makePublic) {
  console.log('[upload-image-samples] Granting public object read on bucket...')
  run('gcloud', [
    ...gcloudBase,
    'buckets',
    'add-iam-policy-binding',
    `gs://${args.bucket}`,
    '--member=allUsers',
    '--role=roles/storage.objectViewer',
  ])
}

const baseUrl = `https://storage.googleapis.com/${args.bucket}`
console.log('\nDone.')
console.log(`Set IMAGE_SAMPLES_BASE_URL=${baseUrl}`)
console.log(`Image URLs will resolve as: ${baseUrl}/${args.prefix}/<file>.jpg`)
