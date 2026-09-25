import { loadSchema } from './src/rithmic/protocol/registry.ts';
import { RithmicCodec } from './src/rithmic/protocol/codec.ts';
import { MockRithmicTransport } from './src/rithmic/transport/transport.ts';
import { RithmicPlant } from './src/rithmic/plants/plant.ts';
const codec = new RithmicCodec(loadSchema({ force: true }));
const t = new MockRithmicTransport('wss://x');
t.serverHandler = (frame) => {
  const d = codec.decode(frame);
  const echo = d.message?.user_msg ?? [];
  if (d.name === 'RequestLogin') {
    t.injectMessage(codec.encode('ResponseLogin', { rp_code: ['5'], user_msg: echo, fcm_id: 'F' }));
  }
};
const plant = new RithmicPlant({ kind:'TICKER', url:'wss://x', transportFactory: ()=>t, login:{user:'u',password:'p',systemName:'Rithmic Test',appName:'A',appVersion:'9'} });
try { await plant.start(); console.log('RESOLVED state=', plant.getState()); } catch(e){ console.log('REJECTED', e.name, e.code); }
