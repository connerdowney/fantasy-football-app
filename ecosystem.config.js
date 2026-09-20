module.exports = {
  apps: [{
    name: 'fantasy-dashboard',
    script: 'server.js',
    watch: true,
    ignore_watch: [
      'node_modules',
      'nohup.out',
      '.git',
      'scripts',
      '*.log',
      'package-lock.json',
      'fantasy-data.db-wal',
      'fantasy-data.db-shm',
      '.yahoo-ext-cache.json',
      '.fuse_hidden*'
    ],
    watch_options: {
      followSymlinks: false,
      usePolling: false
    },
    env: {
      NODE_ENV: 'development'
    }
  }]
};
