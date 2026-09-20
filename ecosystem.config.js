module.exports = {
  apps: [{
    name: 'server',
    script: 'server.js',
    watch: true,
    ignore_watch: ['node_modules', 'logs', '.git', 'fantasy-data.db', 'credentials.json'],
    watch_options: {
      followSymlinks: false
    }
  }]
};
