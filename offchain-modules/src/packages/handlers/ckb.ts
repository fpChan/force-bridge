import { CkbDb } from '../db';
import { CkbMint, ICkbBurn } from '../db/model';
import { logger } from '../utils/logger';
import { asyncSleep, fromHexString, toHexString, uint8ArrayToString } from '../utils';
import { Asset, BtcAsset, ChainType, EosAsset, EthAsset, TronAsset } from '../ckb/model/asset';
import { Address, AddressType, Amount, HashType, Script } from '@lay2/pw-core';

import { getAssetTypeByAsset } from '@force-bridge/xchain/tron/utils';
import { CkbTxGenerator } from '@force-bridge/ckb/tx-helper/generator';
import { IndexerCollector } from '@force-bridge/ckb/tx-helper/collector';
import { ScriptType } from '@force-bridge/ckb/tx-helper/indexer';
import { ForceBridgeCore } from '@force-bridge/core';
import { Script as LumosScript } from '@ckb-lumos/base';
import { RecipientCellData } from '@force-bridge/ckb/tx-helper/generated/eth_recipient_cell';
import { Indexer } from '@ckb-lumos/indexer';
import { sealTransaction } from '@ckb-lumos/helpers';
import { key } from '@ckb-lumos/hd';
import TransactionManager from '@ckb-lumos/transaction-manager';
import { RPC } from '@ckb-lumos/rpc';

import Transaction = CKBComponents.Transaction;
import TransactionWithStatus = CKBComponents.TransactionWithStatus;
import { serializeMultisigScript } from '@ckb-lumos/common-scripts/lib/secp256k1_blake160_multisig';
import { getMultisigLock } from '@force-bridge/ckb/tx-helper/multisig/multisig_helper';
import { JSONRPCClient } from 'json-rpc-2.0';
import fetch from 'node-fetch/index';
import { MultiSigMgr } from '@force-bridge/multisig/multisig-mgr';

const lumosIndexerData = './indexer-data';
// CKB handler
// 1. Listen CKB chain to get new burn events.
// 2. Listen database to get new mint events, send tx.
export class CkbHandler {
  private ckb;
  private indexer;
  private ckbIndexer;
  private transactionManager;
  private multisigMgr;
  constructor(private db: CkbDb) {
    this.ckb = ForceBridgeCore.ckb;
    this.indexer = new Indexer(ForceBridgeCore.config.ckb.ckbRpcUrl, lumosIndexerData);
    this.ckbIndexer = ForceBridgeCore.ckbIndexer;
    this.indexer.startForever();
    this.transactionManager = new TransactionManager(this.indexer);
    this.multisigMgr = new MultiSigMgr(
      'CKB',
      ForceBridgeCore.config.ckb.hosts,
      ForceBridgeCore.config.ckb.multisigScript.M,
    );
  }

  // save unlock event first and then
  async saveBurnEvent(burns: ICkbBurn[]): Promise<void> {
    logger.debug('save burn event:', burns);
    for (const burn of burns) {
      switch (burn.chain) {
        case ChainType.BTC:
          await this.db.createBtcUnlock([
            {
              ckbTxHash: burn.ckbTxHash,
              asset: burn.asset,
              amount: burn.amount,
              chain: burn.chain,
              recipientAddress: burn.recipientAddress,
            },
          ]);
          break;
        case ChainType.ETH:
          await this.db.createEthUnlock([
            {
              ckbTxHash: burn.ckbTxHash,
              asset: burn.asset,
              amount: burn.amount,
              recipientAddress: burn.recipientAddress,
            },
          ]);
          break;
        case ChainType.TRON:
          await this.db.createTronUnlock([
            {
              ckbTxHash: burn.ckbTxHash,
              asset: burn.asset,
              assetType: getAssetTypeByAsset(burn.asset),
              amount: burn.amount,
              recipientAddress: burn.recipientAddress,
            },
          ]);
          break;
        case ChainType.EOS:
          await this.db.createEosUnlock([
            {
              ckbTxHash: burn.ckbTxHash,
              asset: burn.asset,
              amount: burn.amount,
              recipientAddress: burn.recipientAddress,
            },
          ]);
          break;
        default:
          throw new Error(`wrong burn chain type: ${burn.chain}`);
      }
      await this.db.createCkbBurn([burn]);
    }
  }

  async watchBurnEvents(): Promise<never> {
    // get cursor from db, usually the block height, to start the poll or subscribe
    // invoke saveBurnEvent when get new one
    let latestHeight = await this.db.getCkbLatestHeight();
    while (true) {
      logger.debug('watch burn event height: ', latestHeight);
      const block = await this.ckb.rpc.getBlockByNumber(BigInt(latestHeight));
      if (block == null) {
        logger.debug('waiting for new ckb block');
        await asyncSleep(5000);
        continue;
      }
      const burnTxs = new Map();
      for (const tx of block.transactions) {
        const recipientData = tx.outputsData[0];
        let cellData;
        try {
          cellData = new RecipientCellData(fromHexString(recipientData).buffer);
        } catch (e) {
          continue;
        }
        if (await this.isBurnTx(tx, cellData)) {
          const burnPreviousTx: TransactionWithStatus = await this.ckb.rpc.getTransaction(
            tx.inputs[0].previousOutput.txHash,
          );
          const senderLockHash = this.ckb.utils.scriptToHash(
            burnPreviousTx.transaction.outputs[Number(tx.inputs[0].previousOutput.index)].lock,
          );
          const data: BurnDbData = {
            senderLockScriptHash: senderLockHash,
            cellData: cellData,
          };
          burnTxs.set(tx.hash, data);
        }
      }
      logger.debug('get new burn events and save to db', burnTxs);
      if (burnTxs.size > 0) {
        const ckbBurns = [];
        burnTxs.forEach((v: BurnDbData, k: string) => {
          const chain = v.cellData.getChain();
          let burn: ICkbBurn;
          switch (chain) {
            case ChainType.BTC:
            case ChainType.TRON:
            case ChainType.ETH:
            case ChainType.EOS:
              burn = {
                senderLockHash: v.senderLockScriptHash,
                ckbTxHash: k,
                asset: uint8ArrayToString(new Uint8Array(v.cellData.getAsset().raw())),
                chain,
                amount: Amount.fromUInt128LE(`0x${toHexString(new Uint8Array(v.cellData.getAmount().raw()))}`).toString(
                  0,
                ),
                recipientAddress: uint8ArrayToString(new Uint8Array(v.cellData.getRecipientAddress().raw())),
                blockNumber: latestHeight,
              };
              break;
          }
          ckbBurns.push(burn);
        });
        await this.saveBurnEvent(ckbBurns);
      }
      latestHeight++;
      await asyncSleep(1000);
    }
  }

  async isBurnTx(tx: Transaction, cellData: RecipientCellData): Promise<boolean> {
    if (tx.outputs.length < 1) {
      return false;
    }
    const ownLockHash = await this.getOwnLockHash();
    logger.debug('amount: ', toHexString(new Uint8Array(cellData.getAmount().raw())));
    logger.debug('recipient address: ', toHexString(new Uint8Array(cellData.getRecipientAddress().raw())));
    logger.debug('asset: ', toHexString(new Uint8Array(cellData.getAsset().raw())));
    logger.debug('chain: ', cellData.getChain());
    let asset;
    const assetAddress = toHexString(new Uint8Array(cellData.getAsset().raw()));
    switch (cellData.getChain()) {
      case ChainType.BTC:
        asset = new BtcAsset(uint8ArrayToString(fromHexString(assetAddress)), ownLockHash);
        break;
      case ChainType.ETH:
        asset = new EthAsset(uint8ArrayToString(fromHexString(assetAddress)), ownLockHash);
        break;
      case ChainType.TRON:
        asset = new TronAsset(uint8ArrayToString(fromHexString(assetAddress)), ownLockHash);
        break;
      case ChainType.EOS:
        asset = new EosAsset(uint8ArrayToString(fromHexString(assetAddress)), ownLockHash);
        break;
      default:
        return false;
    }

    // verify tx input: sudt cell.
    const preHash = tx.inputs[0].previousOutput.txHash;
    const txPrevious = await this.ckb.rpc.getTransaction(preHash);
    if (txPrevious == null) {
      return false;
    }
    const sudtType = txPrevious.transaction.outputs[Number(tx.inputs[0].previousOutput.index)].type;
    const expectType = {
      codeHash: ForceBridgeCore.config.ckb.deps.sudtType.script.codeHash,
      hashType: ForceBridgeCore.config.ckb.deps.sudtType.script.hashType,
      args: this.getBridgeLockHash(asset),
    };
    logger.debug('expectType:', expectType);
    logger.debug('sudtType:', sudtType);
    if (sudtType == null || expectType.codeHash != sudtType.codeHash || expectType.args != sudtType.args) {
      return false;
    }

    // verify tx output recipientLockscript: recipient cell.
    const recipientScript = tx.outputs[0].type;
    const expect = ForceBridgeCore.config.ckb.deps.recipientType.script;
    logger.debug('recipientScript:', recipientScript);
    logger.debug('expect:', expect);
    return recipientScript.codeHash == expect.codeHash;
  }

  async handleMintRecords(): Promise<never> {
    const ownLockHash = await this.getOwnLockHash();
    const generator = new CkbTxGenerator(this.ckb, new IndexerCollector(this.ckbIndexer));
    while (true) {
      const mintRecords = await this.db.getCkbMintRecordsToMint();
      logger.debug('new mintRecords: ', mintRecords);
      if (mintRecords.length == 0) {
        logger.debug('wait for new mint records');
        await asyncSleep(3000);
        continue;
      }
      const records = mintRecords.map((r) => this.filterMintRecords(r, ownLockHash));
      const newTokens = await this.filterNewTokens(records);

      if (newTokens.length > 0) {
        logger.debug('bridge cell is not exist. do create bridge cell.');
        await this.waitUntilSync();
        await this.createBridgeCell(newTokens, generator);
      }
      try {
        mintRecords.map((r) => {
          r.status = 'pending';
        });
        await this.db.updateCkbMint(mintRecords);
        await this.waitUntilSync();
        const txSkeleton = await generator.mint(records, this.indexer);
        const content0 = key.signRecoverable(
          txSkeleton.get('signingEntries').get(0).message,
          ForceBridgeCore.config.ckb.fromPrivateKey,
        );
        let content1 = serializeMultisigScript(ForceBridgeCore.config.ckb.multisigScript);

        const sigs = await this.multisigMgr.collectSignatures({
          rawData: '',
          payload: {
            txSkeleton,
          },
        });
        content1 += sigs.join('');

        const tx = sealTransaction(txSkeleton, [content0, content1]);
        console.log('tx:', JSON.stringify(tx, null, 2));
        const mintTxHash = await this.transactionManager.send_transaction(tx);
        const txStatus = await this.waitUntilCommitted(mintTxHash, 60);
        if (txStatus.txStatus.status === 'committed') {
          mintRecords.map((r) => {
            r.status = 'success';
            r.mintHash = mintTxHash;
          });
        } else {
          mintRecords.map((r) => {
            r.status = 'error';
            r.mintHash = mintTxHash;
            r.message = `mint execute failed.the tx status is ${txStatus.txStatus.status}`;
          });
          logger.error('mint execute failed: ', mintRecords);
        }
        await this.db.updateCkbMint(mintRecords);
      } catch (e) {
        logger.debug('mint execute failed:', e.toString());
        mintRecords.map((r) => {
          r.status = 'error';
          r.message = e.toString();
        });
        await this.db.updateCkbMint(mintRecords);
      }
    }
  }

  filterMintRecords(r: CkbMint, ownLockHash: string): any {
    switch (r.chain) {
      case ChainType.BTC:
        return {
          asset: new BtcAsset(r.asset, ownLockHash),
          recipient: new Address(r.recipientLockscript, AddressType.ckb),
          amount: new Amount(r.amount, 0),
        };
      case ChainType.ETH:
        return {
          asset: new EthAsset(r.asset, ownLockHash),
          recipient: new Address(r.recipientLockscript, AddressType.ckb),
          amount: new Amount(r.amount, 0),
        };
      case ChainType.TRON:
        return {
          asset: new TronAsset(r.asset, ownLockHash),
          amount: new Amount(r.amount, 0),
          recipient: new Address(r.recipientLockscript, AddressType.ckb),
        };
      case ChainType.EOS:
        return {
          asset: new EosAsset(r.asset, ownLockHash),
          amount: new Amount(r.amount, 0),
          recipient: new Address(r.recipientLockscript, AddressType.ckb),
        };
      default:
        throw new Error('asset not supported!');
    }
  }

  async filterNewTokens(records: any[]): Promise<any[]> {
    const newTokens = [];
    const assets = [];
    for (const record of records) {
      if (assets.indexOf(record.asset.toBridgeLockscriptArgs()) != -1) {
        continue;
      }
      assets.push(record.asset.toBridgeLockscriptArgs());

      logger.debug('record:', record);
      const bridgeCellLockscript = {
        codeHash: ForceBridgeCore.config.ckb.deps.bridgeLock.script.codeHash,
        hashType: ForceBridgeCore.config.ckb.deps.bridgeLock.script.hashType,
        args: record.asset.toBridgeLockscriptArgs(),
      };
      logger.debug('record: bridgeCellLockscript ', bridgeCellLockscript);
      const searchKey = {
        script: new Script(
          bridgeCellLockscript.codeHash,
          bridgeCellLockscript.args,
          <HashType>bridgeCellLockscript.hashType,
        ).serializeJson() as LumosScript,
        script_type: ScriptType.lock,
      };
      const bridgeCells = await this.ckbIndexer.getCells(searchKey);
      if (bridgeCells.length == 0) {
        newTokens.push(record);
      }
    }
    return newTokens;
  }

  async createBridgeCell(newTokens: any[], generator: CkbTxGenerator) {
    const scripts = newTokens.map((r) => {
      return new Script(
        ForceBridgeCore.config.ckb.deps.bridgeLock.script.codeHash,
        r.asset.toBridgeLockscriptArgs(),
        ForceBridgeCore.config.ckb.deps.bridgeLock.script.hashType,
      );
      // return {
      //   codeHash: ForceBridgeCore.config.ckb.deps.bridgeLock.script.codeHash,
      //   hashType: HashType.data,
      //   args: r.asset.toBridgeLockscriptArgs(),
      // };
    });

    const txSkeleton = await generator.createBridgeCell(scripts, this.indexer);
    console.log('signingEntries length:', txSkeleton.get('signingEntries').size);
    const message0 = txSkeleton.get('signingEntries').get(0).message;
    const content0 = key.signRecoverable(message0, ForceBridgeCore.config.ckb.fromPrivateKey);
    let content1 = serializeMultisigScript(ForceBridgeCore.config.ckb.multisigScript);
    const sigs = await this.multisigMgr.collectSignatures({
      rawData: txSkeleton.get('signingEntries').get(1).message,
      payload: {
        txSkeleton,
      },
    });
    content1 += sigs.join('');

    const tx = sealTransaction(txSkeleton, [content0, content1]);
    console.log('tx:', JSON.stringify(tx, null, 2));
    const txHash = await this.transactionManager.send_transaction(tx);
    await this.waitUntilCommitted(txHash, 60);
  }

  async waitUntilSync(): Promise<void> {
    const ckbRpc = new RPC(ForceBridgeCore.config.ckb.ckbRpcUrl);
    const rpcTipNumber = parseInt((await ckbRpc.get_tip_header()).number, 16);
    logger.debug('rpcTipNumber', rpcTipNumber);
    let index = 0;
    while (true) {
      const indexerTipNumber = parseInt((await this.indexer.tip()).block_number, 16);
      logger.debug('indexerTipNumber', indexerTipNumber);
      if (indexerTipNumber >= rpcTipNumber) {
        return;
      }
      logger.debug(`wait until indexer sync. index: ${index++}`);
      await asyncSleep(1000);
    }
  }

  async getOwnLockHash(): Promise<string> {
    const multisigLockScript = getMultisigLock();
    const ownLockHash = this.ckb.utils.scriptToHash(<CKBComponents.Script>{
      codeHash: multisigLockScript.code_hash,
      hashType: multisigLockScript.hash_type,
      args: multisigLockScript.args,
    });
    return ownLockHash;
  }

  getBridgeLockHash(asset: Asset): string {
    const bridgeCellLockscript = {
      codeHash: ForceBridgeCore.config.ckb.deps.bridgeLock.script.codeHash,
      hashType: ForceBridgeCore.config.ckb.deps.bridgeLock.script.hashType,
      args: asset.toBridgeLockscriptArgs(),
    };
    const bridgeLockHash = this.ckb.utils.scriptToHash(<CKBComponents.Script>bridgeCellLockscript);
    return bridgeLockHash;
  }

  async waitUntilCommitted(txHash: string, timeout: number) {
    let waitTime = 0;
    while (true) {
      const txStatus = await this.ckb.rpc.getTransaction(txHash);
      if (txStatus != undefined) {
        logger.debug(`tx ${txHash} status: ${txStatus.txStatus.status}, index: ${waitTime}`);
        if (txStatus.txStatus.status === 'committed') {
          return txStatus;
        }
        await asyncSleep(1000);
        waitTime += 1;
        if (waitTime >= timeout) {
          return txStatus;
        }
      } else {
        logger.error('failed to call ckb rpc getTransaction');
        await asyncSleep(1000);
      }
    }
  }

  start(): void {
    this.watchBurnEvents();
    this.handleMintRecords();
    logger.info('ckb handler started 🚀');
  }
}

type BurnDbData = {
  cellData: RecipientCellData;
  senderLockScriptHash: string;
};
