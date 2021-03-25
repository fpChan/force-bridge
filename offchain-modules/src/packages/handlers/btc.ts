import { logger } from '@force-bridge/utils/logger';
import { asyncSleep } from '@force-bridge/utils';
import { ChainType } from '@force-bridge/ckb/model/asset';
import { BTCChain, BtcLockData } from '@force-bridge/xchain/btc';
import { BtcDb } from '@force-bridge/db/btc';
import { throws } from 'assert';

export class BtcHandler {
  constructor(private db: BtcDb, private btcChain: BTCChain) {}

  // listen ETH chain and handle the new lock events
  async watchLockEvents() {
    logger.debug('start btc watchLockEvents');
    while (true) {
      const latestHeight = await this.db.getLatestHeight();
      const nowTips = await this.btcChain.getBtcHeight();
      logger.debug('btc db lock record latest height: ', latestHeight, 'chain now height: ', nowTips);
      await this.btcChain.watchBtcTxEvents(
        latestHeight + 1,
        nowTips,
        async (btcLockEventData: BtcLockData) => {
          logger.debug('btc lock event data :', btcLockEventData);
          await this.db.createCkbMint([
            {
              id: btcLockEventData.txId,
              chain: ChainType.BTC,
              amount: btcLockEventData.amount,
              asset: 'btc',
              recipientLockscript: btcLockEventData.data,
            },
          ]);
          await this.db.createBtcLock([
            {
              txid: btcLockEventData.txId,
              txIndex: btcLockEventData.txIndex,
              txHash: btcLockEventData.txHash,
              amount: btcLockEventData.amount,
              receiptAddress: btcLockEventData.data,
              blockHeight: btcLockEventData.blockHeight,
              blockHash: btcLockEventData.blockHash,
            },
          ]);
          logger.debug(`save CkbMint and BTCLock successful for BTC tx ${btcLockEventData.txHash}.`);
        },
        async (ckbTxHash: string) => {
          const records = await this.db.getNotSuccessUnlockRecord(ckbTxHash);
          logger.debug('unlock records', records);
          if (records.length === 0) {
            return;
          }
          if (records.length > 1) {
            throw new Error(`there are some unlock record which have the same ckb burn hash.  ${records}`);
          }
          records[0].status = 'success';
          await this.db.saveBtcUnlock(records);
        },
      );
      await asyncSleep(1000 * 10);
    }
  }

  // watch the BTC_unlock table and handle the new unlock events
  // send tx according to the data
  async watchUnlockEvents() {
    // todo: get and handle pending and error records
    logger.debug('start btc watchUnlockEvents');
    while (true) {
      await asyncSleep(1000 * 20);
      logger.debug('get new unlock events and send tx');
      const records = await this.db.getBtcUnlockRecords('todo');
      if (records.length === 0) {
        continue;
      }
      try {
        // write db first, avoid send tx success and fail to write db
        records.map((r) => {
          r.status = 'pending';
        });
        await this.db.saveBtcUnlock(records);
        const txRes = await this.btcChain.sendUnlockTxs(records);
        records.map((r) => {
          r.status = 'pending';
          r.btcTxHash = txRes.txHash;
        });
        await this.db.saveBtcUnlock(records);
      } catch (e) {
        records.map((r) => {
          r.status = 'error';
          r.message = e.message;
        });
        await this.db.saveBtcUnlock(records);
      }
    }
  }

  start() {
    this.watchLockEvents();
    this.watchUnlockEvents();
    logger.info('BTC handler started  🚀');
  }
}
