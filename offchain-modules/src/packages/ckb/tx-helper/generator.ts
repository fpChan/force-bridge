import { Address, Amount, HashType, Script, Transaction } from '@lay2/pw-core';
import { Script as LumosScript } from '@ckb-lumos/base';
import { Asset, ChainType } from '../model/asset';
import { logger } from '@force-bridge/utils/logger';
import { ScriptType } from '@force-bridge/ckb/tx-helper/indexer';
import { IndexerCollector } from '@force-bridge/ckb/tx-helper/collector';
import { stringToUint8Array, toHexString } from '@force-bridge/utils';
// import { SerializeRecipientCellData } from '@force-bridge/eth_recipient_cell.js';
const CKB = require('@nervosnetwork/ckb-sdk-core').default;
const nconf = require('nconf');

export interface MintAssetRecord {
  asset: Asset;
  amount: Amount;
  recipient: Address;
}

export class CkbTxGenerator {
  constructor(private ckb: typeof CKB, private collector: IndexerCollector) {}

  async deploy(fromLockscript: Script, binaries: Buffer[]): Promise<Transaction> {
    throw new Error('not implemented');
  }

  async createBridgeCell(
    fromLockscript: Script,
    bridgeLockscripts: any[],
  ): Promise<CKBComponents.RawTransactionToSign> {
    logger.debug('createBredgeCell:', bridgeLockscripts);
    const bridgeCellCapacity = 100n * 10n ** 8n;
    const outputsData = ['0x'];
    const outputBridgeCells = bridgeLockscripts.map((s) => {
      outputsData.push('0x');
      return {
        lock: s,
        capacity: `0x${bridgeCellCapacity.toString(16)}`,
      };
    });
    let outputs = new Array(0);
    outputs = outputs.concat(outputBridgeCells);
    const fee = 100000n;
    const needSupplyCap = bridgeCellCapacity * BigInt(bridgeLockscripts.length) + fee;
    const supplyCapCells = await this.collector.getCellsByLockscriptAndCapacity(
      fromLockscript,
      Amount.fromUInt128LE(bigintToSudtAmount(needSupplyCap)),
    );
    const inputs = supplyCapCells.map((cell) => {
      return { previousOutput: cell.outPoint, since: '0x0' };
    });
    const inputCap = supplyCapCells.map((cell) => BigInt(cell.capacity)).reduce((a, b) => a + b);
    const changeCellCapacity = inputCap - needSupplyCap;
    if (changeCellCapacity > 64n * 10n ** 8n) {
      const changeLockScript = {
        codeHash: fromLockscript.codeHash,
        hashType: fromLockscript.hashType,
        args: fromLockscript.args,
      };
      const changeCell = {
        lock: changeLockScript,
        capacity: `0x${changeCellCapacity.toString(16)}`,
      };
      outputs.push(changeCell);
    }
    const { secp256k1Dep } = await this.ckb.loadDeps();
    const rawTx = {
      version: '0x0',
      cellDeps: [
        {
          outPoint: secp256k1Dep.outPoint,
          depType: secp256k1Dep.depType,
        },
      ],
      headerDeps: [],
      inputs,
      outputs,
      witnesses: [{ lock: '', inputType: '', outputType: '' }],
      outputsData,
    };
    console.dir({ rawTx }, { depth: null });
    return rawTx;
  }

  async mint(userLockscript: Script, records: MintAssetRecord[]): Promise<CKBComponents.RawTransactionToSign> {
    logger.debug('start to mint records: ', records.length);
    const bridgeCells = new Array(0);
    const outputs = new Array(0);
    const outputsData = new Array(0);
    const sudtCellCapacity = 300n * 10n ** 8n;
    for (const record of records) {
      const recipientLockscript = record.recipient.toLockScript();
      const bridgeCellLockscript = {
        codeHash: nconf.get('forceBridge:ckb:deps:bridgeLock:script:codeHash'),
        hashType: nconf.get('forceBridge:ckb:deps:bridgeLock:script:hashType'),
        args: record.asset.toBridgeLockscriptArgs(),
      };
      const searchKey = {
        script: new Script(
          bridgeCellLockscript.codeHash,
          bridgeCellLockscript.args,
          bridgeCellLockscript.hashType,
        ).serializeJson() as LumosScript,
        script_type: ScriptType.lock,
      };
      const cells = await this.collector.indexer.getCells(searchKey);
      const bridgeCell = cells[0];
      const sudtArgs = this.ckb.utils.scriptToHash(<CKBComponents.Script>bridgeCellLockscript);
      const outputSudtCell = {
        lock: recipientLockscript,
        type: {
          codeHash: nconf.get('forceBridge:ckb:deps:sudt:script:codeHash'),
          hashType: 'data',
          args: sudtArgs,
        },
        capacity: `0x${sudtCellCapacity.toString(16)}`,
      };
      const outputBridgeCell = {
        lock: bridgeCellLockscript,
        capacity: bridgeCell.capacity,
      };
      outputs.push(outputSudtCell);
      outputsData.push(bigintToSudtAmount(record.amount.toBigInt()));
      outputs.push(outputBridgeCell);
      outputsData.push('0x');
      bridgeCells.push(bridgeCell);
    }

    const fee = 100000n;
    // const inputCells = bridgeCells;
    const needSupplyCap = sudtCellCapacity * BigInt(records.length) + fee;
    const supplyCapCells = await this.collector.getCellsByLockscriptAndCapacity(
      userLockscript,
      Amount.fromUInt128LE(bigintToSudtAmount(needSupplyCap)),
    );
    const inputCells = supplyCapCells.concat(bridgeCells);

    const { secp256k1Dep } = await this.ckb.loadDeps();
    console.dir({ secp256k1Dep }, { depth: null });

    // const txTemp = await this.supplyCap(userLockscript, bridgeCells, outputs, outputsData, fee);
    const inputs = inputCells.map((cell) => {
      return { previousOutput: cell.outPoint, since: '0x0' };
    });
    const inputCap = inputCells.map((cell) => BigInt(cell.capacity)).reduce((a, b) => a + b);
    const outputCap = outputs.map((cell) => BigInt(cell.capacity)).reduce((a, b) => a + b);
    const changeCellCapacity = inputCap - outputCap - fee;
    //FIXME: if changeCellCapacity < 64 * 10n ** 8n
    if (changeCellCapacity > 64n * 10n ** 8n) {
      const changeLockScript = {
        codeHash: userLockscript.codeHash,
        hashType: userLockscript.hashType,
        args: userLockscript.args,
      };
      const changeCell = {
        lock: changeLockScript,
        capacity: `0x${changeCellCapacity.toString(16)}`,
      };
      outputs.push(changeCell);
      outputsData.push('0x');
    }

    const rawTx = {
      version: '0x0',
      cellDeps: [
        // secp256k1Dep
        {
          outPoint: secp256k1Dep.outPoint,
          depType: secp256k1Dep.depType,
        },
        // sudt dep
        {
          outPoint: nconf.get('forceBridge:ckb:deps:sudt:cellDep:outPoint'),
          depType: 'code',
        },
        // bridge lockscript dep
        {
          outPoint: nconf.get('forceBridge:ckb:deps:bridgeLock:cellDep:outPoint'),
          depType: 'code',
        },
      ],
      headerDeps: [],
      inputs,
      outputs,
      witnesses: [{ lock: '', inputType: '', outputType: '' }],
      outputsData,
    };
    console.dir({ rawTx }, { depth: null });
    return rawTx;
  }

  /*
  table RecipientCellData {
    recipient_address: Bytes,
    chain: byte,
    asset: Bytes,
    bridge_lock_code_hash: Byte32,
    owner_lock_hash: Byte32,
    amount: Uint128,
    fee: Uint128,
}
   */
  async burn(
    fromLockscript: Script,
    recipientAddress: string,
    asset: Asset,
    amount: Amount,
    bridgeFee?: Amount,
  ): Promise<CKBComponents.RawTransactionToSign> {
    const bridgeCellLockscript = {
      codeHash: nconf.get('forceBridge:ckb:deps:bridgeLock:script:codeHash'),
      hashType: nconf.get('forceBridge:ckb:deps:bridgeLock:script:hashType'),
      args: asset.toBridgeLockscriptArgs(),
    };
    const args = this.ckb.utils.scriptToHash(<CKBComponents.Script>bridgeCellLockscript);
    const searchKey = {
      script: new Script(
        nconf.get('forceBridge:ckb:deps:sudt:script:codeHash'),
        args,
        HashType.data,
      ).serializeJson() as LumosScript,
      script_type: ScriptType.type,
    };
    const sudtCells = await this.collector.indexer.getCells(searchKey);
    // const sudtCells = cells.filter((cell) => cell.lock == fromLockscript);
    logger.debug('burn sudtCells: ', sudtCells);
    let inputCells = [sudtCells[0]];

    const params = {
      recipient_address: recipientAddress,
      chain: asset.chainType,
      asset: asset.getAddress(),
      amount: amount.toUInt128LE(),
      bridge_lock_code_hash: nconf.get('forceBridge:ckb:deps:sudt:script:codeHash'),
      owner_lock_hash: fromLockscript.codeHash,
    };

    // const recipientCellData: any[] = SerializeRecipientCellData(params);
    let recipientCellData;
    switch (params.chain) {
      case ChainType.ETH:
        recipientCellData = `0x0${params.chain}${params.recipient_address.slice(2)}${params.asset.slice(
          2,
        )}${params.amount.slice(2)}${params.bridge_lock_code_hash.slice(2)}${params.owner_lock_hash.slice(2)}`;
        break;
      case ChainType.TRON:
        recipientCellData = `0x0${params.chain}${toHexString(
          stringToUint8Array(params.recipient_address),
        )}${toHexString(stringToUint8Array(params.asset))}${params.amount.slice(2)}${params.bridge_lock_code_hash.slice(
          2,
        )}${params.owner_lock_hash.slice(2)}`;
        break;
      default:
        throw new Error('asset not supported!');
    }
    // const recipientCellData = `0x0${params.chain}${params.recipient_address.slice(2)}${params.asset.slice(
    //   2,
    // )}${params.amount.slice(2)}${params.bridge_lock_code_hash.slice(2)}${params.owner_lock_hash.slice(2)}`;

    const { secp256k1Dep } = await this.ckb.loadDeps();
    console.dir({ secp256k1Dep }, { depth: null });
    const outputs = new Array(0);
    const outputsData = new Array(0);

    const recipientTypeScript = {
      codeHash: nconf.get('forceBridge:ckb:deps:recipientType:script:codeHash'),
      hashType: nconf.get('forceBridge:ckb:deps:recipientType:script:hashType'),
      args: '0x',
    };
    const recipientCap = (BigInt(recipientCellData.length) + 100n) * 10n ** 8n;
    const recipientOutput = {
      lock: fromLockscript,
      type: recipientTypeScript,
      capacity: `0x${recipientCap.toString(16)}`,
    };
    outputs.push(recipientOutput);
    outputsData.push(recipientCellData);

    const total = Amount.fromUInt128LE(sudtCells[0].data);
    let changeAmount = Amount.ZERO;
    const sudtCellCapacity = 300n * 10n ** 8n;
    if (total.gt(amount)) {
      changeAmount = total.sub(amount);
      const changeOutput = {
        lock: sudtCells[0].lock,
        type: sudtCells[0].type,
        capacity: `0x${sudtCellCapacity.toString(16)}`,
      };
      outputs.push(changeOutput);
      outputsData.push(changeAmount.toUInt128LE());
    } else {
      throw new Error('sudt amount is not enough!');
    }
    const fee = 100000n;
    const outputCap = outputs.map((cell) => BigInt(cell.capacity)).reduce((a, b) => a + b);
    const needSupplyCapCells = await this.collector.getCellsByLockscriptAndCapacity(
      fromLockscript,
      Amount.fromUInt128LE(bigintToSudtAmount(outputCap - sudtCellCapacity + fee)),
    );
    inputCells = inputCells.concat(needSupplyCapCells);
    const inputCap = inputCells.map((cell) => BigInt(cell.capacity)).reduce((a, b) => a + b);
    // await this.supplyCap(fromLockscript, inputCells, outputs, outputsData, fee);
    const changeCellCapacity = inputCap - outputCap - fee;
    if (changeCellCapacity > 64n * 10n ** 8n) {
      const changeLockScript = {
        codeHash: fromLockscript.codeHash,
        hashType: fromLockscript.hashType,
        args: fromLockscript.args,
      };
      const changeCell = {
        lock: changeLockScript,
        capacity: `0x${changeCellCapacity.toString(16)}`,
      };
      outputs.push(changeCell);
      outputsData.push('0x');
    }
    const inputs = inputCells.map((cell) => {
      return { previousOutput: cell.outPoint, since: '0x0' };
    });

    const rawTx = {
      version: '0x0',
      cellDeps: [
        // secp256k1Dep
        {
          outPoint: secp256k1Dep.outPoint,
          depType: secp256k1Dep.depType,
        },
        // sudt dep
        {
          outPoint: nconf.get('forceBridge:ckb:deps:sudt:cellDep:outPoint'),
          depType: 'code',
        },
        // recipient dep
        {
          outPoint: nconf.get('forceBridge:ckb:deps:recipientType:cellDep:outPoint'),
          depType: 'code',
        },
      ],
      headerDeps: [],
      inputs,
      outputs,
      witnesses: [{ lock: '', inputType: '', outputType: '' }],
      outputsData,
    };
    console.dir({ rawTx }, { depth: null });
    return rawTx;
    // throw new Error('not implemented');
  }

  async supplyCap(lockscript, inputsCell, outputs, outputsData, fee) {
    let inputCap = inputsCell.map((cell) => BigInt(cell.capacity)).reduce((a, b) => a + b);
    const outputCap = outputs.map((cell) => BigInt(cell.capacity)).reduce((a, b) => a + b);
    const needSupplyCapCells = await this.collector.getCellsByLockscriptAndCapacity(
      lockscript,
      Amount.fromUInt128LE(bigintToSudtAmount(outputCap - inputCap + fee)),
    );
    inputsCell = inputsCell.concat(needSupplyCapCells);
    inputCap = inputsCell.map((cell) => BigInt(cell.capacity)).reduce((a, b) => a + b);
    const changeCellCapacity = inputCap - outputCap - fee;
    if (changeCellCapacity > 64n * 10n ** 8n) {
      const changeLockScript = {
        codeHash: lockscript.codeHash,
        hashType: lockscript.hashType,
        args: lockscript.args,
      };
      const changeCell = {
        lock: changeLockScript,
        capacity: `0x${changeCellCapacity.toString(16)}`,
      };
      outputs.push(changeCell);
      outputsData.push('0x');
    }
    return {
      inputsCell: inputsCell,
      outputs: outputs,
      outputsData: outputsData,
    };
  }
}

const bigintToSudtAmount = (n) => {
  return `0x${Buffer.from(n.toString(16).padStart(32, '0'), 'hex').reverse().toString('hex')}`;
};
