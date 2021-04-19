import { Indexer } from '@ckb-lumos/indexer';
import { init } from './init_config';
import { TransactionSkeleton, sealTransaction, parseAddress, minimalCellCapacity } from '@ckb-lumos/helpers';
import { HashType } from '@ckb-lumos/base';
import { fromAddress, multisigAddress, fromPrivateKey, multisigLockScript } from './multisig_helper';
import { common } from '@ckb-lumos/common-scripts';
import { key } from '@ckb-lumos/hd';
import { generateTypeIDScript } from './typeid';

const TransactionManager = require('@ckb-lumos/transaction-manager');
const CKB = require('@nervosnetwork/ckb-sdk-core').default;
const nconf = require('nconf');

const CKB_URL = process.env.CKB_URL || 'http://127.0.0.1:8114';
init();

const acpData = '0x';

console.log('Capacity fromAddress:', fromAddress);

const ckb = new CKB(CKB_URL);
const dataDir = './lumos_db';
const indexer = new Indexer('http://127.0.0.1:8114', dataDir);
indexer.startForever();
const transactionManager = new TransactionManager(indexer);

function getDataOutputCapacity() {
  const output = {
    cell_output: {
      lock: parseAddress(multisigAddress),
      type: {
        code_hash: '0x' + '0'.repeat(64),
        hash_type: 'type' as HashType,
        args: '0x' + '0'.repeat(64),
      },
      capacity: '0x0',
    },
    data: acpData,
  };

  const min = minimalCellCapacity(output);
  return min;
}

async function deploy() {
  let txSkeleton = TransactionSkeleton({ cellProvider: indexer });
  const capacity = getDataOutputCapacity();
  console.log('capacity:', capacity);
  await asyncSleep(5 * 1000);
  console.log('before transfer txSkeleton:', JSON.stringify(txSkeleton, null, 2));
  txSkeleton = await common.transfer(txSkeleton, [fromAddress], multisigAddress, capacity);
  console.log('after transfer txSkeleton:', JSON.stringify(txSkeleton, null, 2));
  const firstOutput = txSkeleton.get('outputs').get(0);
  firstOutput.data = acpData;
  const firstInput = {
    previous_output: txSkeleton.get('inputs').get(0).out_point,
    since: '0x0',
  };
  const typeIDScript = generateTypeIDScript(firstInput, '0x0');
  firstOutput.cell_output.type = typeIDScript;
  txSkeleton = txSkeleton.update('outputs', (outputs) => {
    return outputs.set(0, firstOutput);
  });
  const feeRate = 1000n;
  txSkeleton = await common.payFeeByFeeRate(txSkeleton, [fromAddress], feeRate);
  txSkeleton = common.prepareSigningEntries(txSkeleton);
  const message = txSkeleton.get('signingEntries').get(0).message;
  const content = key.signRecoverable(message, fromPrivateKey);

  const tx = sealTransaction(txSkeleton, [content]);
  console.log('tx:', JSON.stringify(tx, null, 2));
  const txHash = await transactionManager.send_transaction(tx);
  await waitUntilCommitted(ckb, txHash, 60);

  nconf.set('type', typeIDScript);
  nconf.save();

  // const deployResult = require('./deploy_result.json');
  // const multisigType = deployResult.type;
  console.log('multi lockscript:', JSON.stringify(multisigLockScript, null, 2));
  process.exit(0);
}

async function waitUntilCommitted(ckb, txHash, timeout) {
  let waitTime = 0;
  while (true) {
    const txStatus = await ckb.rpc.getTransaction(txHash);
    console.log(`tx ${txHash} status: ${txStatus.txStatus.status}, index: ${waitTime}`);
    if (txStatus.txStatus.status === 'committed') {
      return txStatus;
    }
    await asyncSleep(1000);
    waitTime += 1;
    if (waitTime >= timeout) {
      return txStatus;
    }
  }
}

function asyncSleep(ms = 0) {
  return new Promise((r) => setTimeout(r, ms));
}

const main = async () => {
  console.log('\n\n\n---------start init multisig address -----------\n');
  // await indexer.waitForSync();
  const configPath = './src/packages/ckb/tx-helper/multisig/infos.json';
  nconf.env().file({ file: configPath });
  await deploy();
  console.log('\n\n\n---------end init multisig address -----------\n');
  process.exit(0);
};

main();
