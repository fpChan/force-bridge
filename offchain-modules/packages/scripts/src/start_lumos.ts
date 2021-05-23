import { Indexer } from '@ckb-lumos/sql-indexer';
import nconf from 'nconf';
import {getLumosIndexKnex} from "@force-bridge/x/dist/utils";
const configPath = './config.json';
nconf.env().file({ file: configPath });
const CKB_URL = nconf.get('forceBridge:ckb:ckbRpcUrl');
const sqlIndexer = new Indexer(CKB_URL, getLumosIndexKnex());
sqlIndexer.startForever();
