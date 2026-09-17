// PM2 多进程 cluster 配置 —— 解决 mock 单 Node 进程单核瓶颈
// 用法（在 192.168.0.4 项目目录下）：
//   pm2 start ecosystem.config.cjs
//   pm2 restart ecosystem.config.cjs   # 改代码/改 env 后
//   pm2 logs mock-llm                  # 看日志
//   pm2 monit                          # 实时看每个 worker 的 CPU
// 注意：cluster 模式下 /metrics 是各 worker 独立计数，
//       对账时把 N 个 worker 的数加总（curl 端口会轮询到不同 worker）。
module.exports = {
  apps: [
    {
      name: 'mock-llm',
      script: './server.js',
      cwd: __dirname,
      // 9950X = 16 核 32 线程；机器是工作站还跑别的东西 + 内网穿透，
      // 留足余量给穿透进程。12 worker 对 1000 VU 压测绰绰有余。
      instances: 12,
      exec_mode: 'cluster',
      // 压测流式请求都是长连接，reload/stop 要给足排空时间
      // （server.js 有 SIGTERM 优雅排空，最长 15s，这里 kill_timeout 要 >= 15s）
      wait_ready: false,
      kill_timeout: 20000,
      listen_timeout: 10000,
      // 挂了自动拉起；内存超 1G 重启（防泄漏）
      autorestart: true,
      max_memory_restart: '1G',
      // 输出按 worker 分文件，便于对账单个 worker
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-err.log',
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        HOST: '0.0.0.0',
        PORT: 8787,
        // === 延迟模型（按需改）===
        TTFT_MS: 800,
        TOKEN_INTERVAL_MS: 25,
        // === 故障注入（压测排除干扰时全 0）===
        ERROR_429_RATE: 0,
        ERROR_500_RATE: 0,
        ERROR_TIMEOUT_RATE: 0,
        ERROR_DISCONNECT_RATE: 0,
        ERROR_PAUSE_RATE: 0,
        ERROR_HEARTBEAT_RATE: 0,
        ERROR_EVENT_RATE: 0,
      },
    },
  ],
};
