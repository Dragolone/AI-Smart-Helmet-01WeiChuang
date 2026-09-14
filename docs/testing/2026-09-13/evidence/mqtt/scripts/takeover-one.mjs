import mqtt from 'mqtt';
import fs from 'node:fs';
const EV='/Users/dravenzhong/Desktop/AI-Smart-Helmet-01WeiChuang/docs/testing/2026-09-13/evidence/mqtt';
const env=Object.fromEntries(fs.readFileSync(`${EV}/.devices.env`,'utf8').trim().split('\n').map(l=>l.split('=')));
const c=mqtt.connect(process.env.MQTT_URL,{clientId:process.env.MQTT_BACKEND_CLIENT_ID,username:env.audit_mqtt_a_DEVICE_ID,password:env.audit_mqtt_a_DEVICE_SECRET,clean:true,reconnectPeriod:0,connectTimeout:4000});
c.on('connect',(a)=>{console.log('CONNECTED sessionPresent=',a.sessionPresent);setTimeout(()=>{c.end(true);process.exit(0)},500)});
c.on('error',(e)=>{console.log('ERROR',e.message);process.exit(0)});
c.on('close',()=>{console.log('CLOSE');});
setTimeout(()=>{console.log('TIMEOUT');process.exit(0)},6000);
