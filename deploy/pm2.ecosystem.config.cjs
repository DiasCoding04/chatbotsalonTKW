const path = require('node:path')

const root = path.resolve(__dirname, '..')

module.exports = {
  apps: [
    {
      name: 'salon-chat-gemini',
      cwd: root,
      script: 'npm',
      args: 'run start:prod',
      interpreter: 'none',
      autorestart: true,
      max_restarts: 20,
      restart_delay: 3000,
    },
  ],
}
