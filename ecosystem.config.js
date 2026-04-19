module.exports = {
  apps: [
    {
      name: 'vpsmmo-monitoring-web',
      script: 'src/server.js',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '512M',
      error_file: '/var/log/vpsmmo-monitoring/app.err.log',
      out_file: '/var/log/vpsmmo-monitoring/app.out.log',
      env_production: { NODE_ENV: 'production', ROLE: 'web' },
    },
    // Placeholder — enabled in Phase 6
    // {
    //   name: 'vpsmmo-monitoring-cron',
    //   script: 'src/cron-runner.js',
    //   instances: 1,
    //   exec_mode: 'fork',
    //   max_memory_restart: '256M',
    //   env_production: { NODE_ENV: 'production', ROLE: 'cron' },
    // },
    // Placeholder — enabled in Phase 7
    // {
    //   name: 'vpsmmo-monitoring-checker',
    //   script: 'src/checker-runner.js',
    //   instances: 1,
    //   exec_mode: 'fork',
    //   max_memory_restart: '512M',
    //   env_production: { NODE_ENV: 'production', ROLE: 'checker' },
    // },
  ],
};
