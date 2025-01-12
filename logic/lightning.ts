/**
 * All Lightning business logic.
 */

/* eslint-disable id-length, max-lines, max-statements */

import { NodeError, convert } from "@runcitadel/utils";

import getLightning from "../services/lightning.js";
import BitcoinLogic from "../logic/bitcoin.js";

import constants from "../utils/const.js";
import {
  Channel,
  ChannelBalanceResponse,
  ChannelFeeReport,
  EstimateFeeResponse,
  ForwardingHistoryResponse,
  GetInfoResponse,
  Initiator,
  Invoice,
  NewAddressResponse,
  Payment,
  PendingChannelsResponse,
  PendingChannelsResponse_ForceClosedChannel,
  PendingChannelsResponse_PendingChannel,
  PendingChannelsResponse_PendingOpenChannel,
  PendingChannelsResponse_WaitingCloseChannel,
  SendCoinsResponse,
  SendResponse,
  Transaction,
  WalletBalanceResponse,
} from "../services/lightning/autogenerated-types.js";
import { ServiceError } from "@grpc/grpc-js";
import { extendedPaymentRequest } from "../services/lightning/abstract.js";
import Lnurl from "./LNUrl.js";

const PENDING_OPEN_CHANNELS = "pendingOpenChannels";
const PENDING_CLOSING_CHANNELS = "pendingClosingChannels";
const PENDING_FORCE_CLOSING_CHANNELS = "pendingForceClosingChannels";
const WAITING_CLOSE_CHANNELS = "waitingCloseChannels";
const PENDING_CHANNEL_TYPES = [
  PENDING_OPEN_CHANNELS,
  PENDING_CLOSING_CHANNELS,
  PENDING_FORCE_CLOSING_CHANNELS,
  WAITING_CLOSE_CHANNELS,
];

type pendingChannelTypes =
  | "pendingOpenChannels"
  | "pendingForceClosingChannels"
  | "waitingCloseChannels";

const MAINNET_GENESIS_BLOCK_TIMESTAMP = 1231035305n;
const TESTNET_GENESIS_BLOCK_TIMESTAMP = 1296717402n;

const FAST_BLOCK_CONF_TARGET = 2;
const NORMAL_BLOCK_CONF_TARGET = 6;
const SLOW_BLOCK_CONF_TARGET = 24;
const CHEAPEST_BLOCK_CONF_TARGET = 144;

const OPEN_CHANNEL_EXTRA_WEIGHT = 10;

const FEE_RATE_TOO_LOW_ERROR = {
  code: "FEE_RATE_TOO_LOW",
  text: "Mempool reject low fee transaction. Increase fee rate.",
};

const INSUFFICIENT_FUNDS_ERROR = {
  code: "INSUFFICIENT_FUNDS",
  text: "Lower amount or increase confirmation target.",
};

const INVALID_ADDRESS = {
  code: "INVALID_ADDRESS",
  text: "Please validate the Bitcoin address is correct.",
};

const OUTPUT_IS_DUST_ERROR = {
  code: "OUTPUT_IS_DUST",
  text: "Transaction output is dust.",
};

const bitcoindLogic = new BitcoinLogic();

// Converts a byte object into a hex string.
export function toHexString(byteObject: Buffer): string {
  const bytes = Object.values(byteObject);

  return bytes
    .map(function (byte) {
      return ("00" + (byte & 0xff).toString(16)).slice(-2); // eslint-disable-line no-magic-numbers
    })
    .join("");
}

type invoice = {
  rHash: Buffer;
  paymentRequest: string;
  rHashStr: string;
};

const lndService = getLightning();
// Creates a new invoice; more commonly known as a payment request.
export async function addInvoice(
  amt: number | string,
  memo: string
): Promise<invoice> {
  const invoice = (await lndService.addInvoice(amt, memo)) as invoice;
  invoice.rHashStr = toHexString(invoice.rHash);

  return invoice;
}

// Closes the channel that corresponds to the given channelPoint. Force close is optional.
export function closeChannel(
  txHash: string,
  index: number,
  force: boolean
): Promise<void> {
  return lndService.closeChannel(txHash, index, force);
}

// Decode the payment request into useful information.
export async function decodePaymentRequest(
  paymentRequest: string
): Promise<extendedPaymentRequest> {
  return await lndService.decodePaymentRequest(paymentRequest);
}

// Estimate the cost of opening a channel. We do this by repurposing the existing estimateFee grpc route from lnd. We
// generate our own unused address and then feed that into the existing call. Then we add an extra 10 sats per
// feerateSatPerByte. This is because the actual cost is slightly more than the default one output estimate.
export async function estimateChannelOpenFee(
  amt: number | string,
  confTarget: number,
  sweep: boolean
): Promise<
  EstimateFeeResponseExtended | Record<string, EstimateFeeResponseExtended>
> {
  const address = (await generateAddress()).address;
  const baseFeeEstimate = await estimateFee(address, amt, confTarget, sweep);

  if (confTarget === 0) {
    const baseFeeEstimateTyped = <Record<string, EstimateFeeResponseExtended>>(
      baseFeeEstimate
    );
    const keys = Object.keys(baseFeeEstimateTyped);

    for (const key of keys) {
      const baseFeeEstimate_key = baseFeeEstimateTyped[key];
      if (baseFeeEstimate_key.feeSat) {
        baseFeeEstimate_key.feeSat = String(
          BigInt(baseFeeEstimate_key.feeSat) +
            BigInt(OPEN_CHANNEL_EXTRA_WEIGHT) *
              BigInt((<EstimateFeeResponse>baseFeeEstimate_key).satPerVbyte)
        );
      }
    }
  }

  return baseFeeEstimate;
}

type EstimateFeeResponseExtended =
  | (EstimateFeeResponse & { sweepAmount?: number })
  | { code: string; text: string; feeSat?: string };

// Estimate an on chain transaction fee.
export async function estimateFee(
  address: string,
  amt: string | number,
  confTarget: number,
  sweep: boolean
): Promise<
  EstimateFeeResponseExtended | Record<string, EstimateFeeResponseExtended>
> {
  const mempoolInfo = await bitcoindLogic.getMempoolInfo();

  if (sweep) {
    const balance = await lndService.getWalletBalance();
    const amtToEstimate = balance.confirmedBalance;

    if (confTarget === 0) {
      return await estimateFeeGroupSweep(
        address,
        amtToEstimate,
        mempoolInfo.mempoolminfee
      );
    }

    return await estimateFeeSweep(
      address,
      amtToEstimate,
      mempoolInfo.mempoolminfee,
      confTarget,
      0,
      amtToEstimate
    );
  } else {
    try {
      if (confTarget === 0) {
        return await estimateFeeGroup(address, amt, mempoolInfo.mempoolminfee);
      }

      return await estimateFeeWrapper(
        address,
        amt,
        mempoolInfo.mempoolminfee,
        confTarget
      );
    } catch (error) {
      return handleEstimateFeeError(error);
    }
  }
}

// Use binary search strategy to determine the largest amount that can be sent.
export async function estimateFeeSweep(
  address: string,
  fullAmtToEstimate: number | string,
  mempoolMinFee: number,
  confTarget: number,
  l: number | string,
  r: number | string
): Promise<EstimateFeeResponseExtended> {
  const amtToEstimate =
    parseInt(<string>l) +
    Math.floor((parseInt(<string>r) - parseInt(<string>l)) / 2);

  try {
    const successfulEstimate: EstimateFeeResponseExtended =
      await lndService.estimateFee(address, amtToEstimate, confTarget);

    // Return after we have completed our search.
    if (l === amtToEstimate) {
      successfulEstimate.sweepAmount = amtToEstimate;

      const estimatedFeeSatPerKiloByte =
        BigInt(successfulEstimate.satPerVbyte) * 1000n;

      if (
        estimatedFeeSatPerKiloByte <
        BigInt(convert(mempoolMinFee, "btc", "sat", "Number").toString())
      ) {
        throw new NodeError("FEE_RATE_TOO_LOW");
      }

      return successfulEstimate;
    }

    return await estimateFeeSweep(
      address,
      fullAmtToEstimate,
      mempoolMinFee,
      confTarget,
      amtToEstimate,
      r
    );
  } catch (error) {
    // Return after we have completed our search.
    if (l === amtToEstimate) {
      return handleEstimateFeeError(error);
    }

    return await estimateFeeSweep(
      address,
      fullAmtToEstimate,
      mempoolMinFee,
      confTarget,
      l,
      amtToEstimate
    );
  }
}

export async function estimateFeeGroupSweep(
  address: string,
  amt: number | string,
  mempoolMinFee: number
): Promise<Record<string, EstimateFeeResponseExtended>> {
  const calls = [
    estimateFeeSweep(
      address,
      amt,
      mempoolMinFee,
      FAST_BLOCK_CONF_TARGET,
      0,
      amt
    ),
    estimateFeeSweep(
      address,
      amt,
      mempoolMinFee,
      NORMAL_BLOCK_CONF_TARGET,
      0,
      amt
    ),
    estimateFeeSweep(
      address,
      amt,
      mempoolMinFee,
      SLOW_BLOCK_CONF_TARGET,
      0,
      amt
    ),
    estimateFeeSweep(
      address,
      amt,
      mempoolMinFee,
      CHEAPEST_BLOCK_CONF_TARGET,
      0,
      amt
    ),
  ];

  const [fast, normal, slow, cheapest] = await Promise.all(
    calls.map((p) => p.catch((error) => handleEstimateFeeError(error)))
  );

  return {
    fast,
    normal,
    slow,
    cheapest,
  };
}

export async function estimateFeeWrapper(
  address: string,
  amt: number | string,
  mempoolMinFee: number,
  confTarget: number
): Promise<EstimateFeeResponse> {
  if (typeof amt === "string") amt = parseInt(amt, 10);
  const estimate = await lndService.estimateFee(address, amt, confTarget);

  const estimatedFeeSatPerKiloByte = BigInt(estimate.satPerVbyte) * 1000n;

  if (
    estimatedFeeSatPerKiloByte <
    BigInt(convert(mempoolMinFee, "btc", "sat", "Number").toString())
  ) {
    throw new NodeError("FEE_RATE_TOO_LOW");
  }

  return estimate;
}

export async function estimateFeeGroup(
  address: string,
  amt: number | string,
  mempoolMinFee: number
): Promise<Record<string, EstimateFeeResponseExtended>> {
  const calls = [
    estimateFeeWrapper(address, amt, mempoolMinFee, FAST_BLOCK_CONF_TARGET),
    estimateFeeWrapper(address, amt, mempoolMinFee, NORMAL_BLOCK_CONF_TARGET),
    estimateFeeWrapper(address, amt, mempoolMinFee, SLOW_BLOCK_CONF_TARGET),
    estimateFeeWrapper(address, amt, mempoolMinFee, CHEAPEST_BLOCK_CONF_TARGET),
  ];

  const [fast, normal, slow, cheapest] = await Promise.all(
    calls.map((p) => p.catch((error) => handleEstimateFeeError(error)))
  );

  return {
    fast,
    normal,
    slow,
    cheapest,
  };
}

export function handleEstimateFeeError(error: unknown): {
  code: string;
  text: string;
} {
  error = <ServiceError>error;
  let realError: ServiceError = <ServiceError>error;
  // @ts-expect-error This works
  if (error.error) realError = error.error;
  if ((<ServiceError>error).message === "FEE_RATE_TOO_LOW") {
    return FEE_RATE_TOO_LOW_ERROR;
  } else if (realError.details === "transaction output is dust") {
    return OUTPUT_IS_DUST_ERROR;
  } else if (
    realError.details ===
    "insufficient funds available to construct transaction"
  ) {
    return INSUFFICIENT_FUNDS_ERROR;
  }

  return INVALID_ADDRESS;
}

// Generates a new on chain segwit bitcoin address.
export async function generateAddress(): Promise<NewAddressResponse> {
  return await lndService.generateAddress();
}

// Generates a new 24 word seed phrase.
export async function generateSeed(): Promise<{ seed: string[] }> {
  const lndStatus = await getStatus();

  if (lndStatus.operational) {
    const response = await lndService.generateSeed();

    return { seed: response.cipherSeedMnemonic };
  }

  throw new NodeError(
    "Lnd is not operational, therefore a seed cannot be created."
  );
}

// Returns the total funds in channels and the total pending funds in channels.
export async function getChannelBalance(): Promise<ChannelBalanceResponse> {
  return await lndService.getChannelBalance();
}

// Returns a count of all open channels.
export function getChannelCount(): Promise<{ count: number }> {
  return lndService
    .getOpenChannels()
    .then((response) => ({ count: response.length }));
}

export function getChannelPolicy(): Promise<ChannelFeeReport[]> {
  return lndService.getFeeReport().then((feeReport) => feeReport.channelFees);
}

export async function getForwardingEvents(
  startTime: number,
  endTime: number,
  indexOffset: number
): Promise<ForwardingHistoryResponse> {
  return await lndService.getForwardingEvents(startTime, endTime, indexOffset);
}

// Returns a list of all invoices.
export async function getInvoices(): Promise<Invoice[]> {
  const invoices = await lndService.getInvoices();

  const reversedInvoices = [];
  for (const invoice of invoices.invoices) {
    reversedInvoices.unshift(invoice);
  }

  return reversedInvoices;
}

type Transaction_extended = Transaction & {
  type?: 
    | "CHANNEL_OPEN"
    | "CHANNEL_CLOSE"
    | "PENDING_OPEN"
    | "PENDING_CLOSE"
    | "UNKNOWN"
    | "ON_CHAIN_TRANSACTION_SENT"
    | "ON_CHAIN_TRANSACTION_RECEIVED";
};

// Returns a list of all on chain transactions.
export async function getOnChainTransactions(): Promise<
  Transaction_extended[]
> {
  const transactions =
    (await lndService.getOnChainTransactions()) as Transaction_extended[];
  const openChannels = await lndService.getOpenChannels();
  const closedChannels = await lndService.getClosedChannels();
  const pendingChannelRPC = await lndService.getPendingChannels();

  const pendingOpeningChannelTransactions = [];
  for (const pendingChannel of pendingChannelRPC.pendingOpenChannels) {
    const pendingTransaction = pendingChannel.channel?.channelPoint
      .split(":")
      .shift();
    pendingOpeningChannelTransactions.push(pendingTransaction);
  }

  const pendingClosingChannelTransactions = [];
  for (const pendingGroup of [
    pendingChannelRPC.pendingForceClosingChannels,
    pendingChannelRPC.waitingCloseChannels,
  ]) {
    if (pendingGroup.length === 0) {
      continue;
    }
    for (const pendingChannel of pendingGroup) {
      // @ts-expect-error The property exists!
      pendingClosingChannelTransactions.push(pendingChannel.closingTxid);
    }
  }

  const openChannelTransactions = [];
  for (const channel of openChannels) {
    const openTransaction = channel.channelPoint.split(":").shift();
    openChannelTransactions.push(openTransaction);
  }

  const closedChannelTransactions = [];
  for (const channel of closedChannels) {
    const closedTransaction = channel.closingTxHash.split(":").shift();
    closedChannelTransactions.push(closedTransaction);

    const openTransaction = channel.channelPoint.split(":").shift();
    openChannelTransactions.push(openTransaction);
  }

  const reversedTransactions = [];
  for (const transaction of transactions) {
    const txHash = transaction.txHash;

    if (openChannelTransactions.includes(txHash)) {
      transaction.type = "CHANNEL_OPEN";
    } else if (closedChannelTransactions.includes(txHash)) {
      transaction.type = "CHANNEL_CLOSE";
    } else if (pendingOpeningChannelTransactions.includes(txHash)) {
      transaction.type = "PENDING_OPEN";
    } else if (pendingClosingChannelTransactions.includes(txHash)) {
      transaction.type = "PENDING_CLOSE";
    } else if (transaction.amount < 0) {
      transaction.type = "ON_CHAIN_TRANSACTION_SENT";
    } else if (transaction.amount > 0 && transaction.destAddresses.length > 0) {
      transaction.type = "ON_CHAIN_TRANSACTION_RECEIVED";

      // Positive amounts are either incoming transactions or a WaitingCloseChannel. There is no way to determine which
      // until the transaction has at least one confirmation. Then a WaitingCloseChannel will become a pending Closing
      // channel and will have an associated tx id.
    } else if (
      transaction.amount > 0 &&
      transaction.destAddresses.length === 0
    ) {
      transaction.type = "PENDING_CLOSE";
    } else {
      transaction.type = "UNKNOWN";
    }

    reversedTransactions.unshift(transaction);
  }

  return reversedTransactions;
}

export function getTxnHashFromChannelPoint(channelPoint: string): string {
  return channelPoint.split(":")[0];
}

type Channel_extended = Channel & {
  type?: string;
};

type WaitingCloseChannel_extended =
  PendingChannelsResponse_WaitingCloseChannel & {
    type?: string;
  };

type PendingForceClosedChannel_extended =
  PendingChannelsResponse_ForceClosedChannel & {
    type?: string;
  };

type PendingOpenChannel_extended =
  PendingChannelsResponse_PendingOpenChannel & {
    type?: string;
    /** @deprecated */
    initiator?: boolean;
    /** @deprecated */
    initiatorText: string;
  };

// Returns a list of all open channels.
export async function getChannels(): Promise<Channel_extended[]> {
  const openChannelsCall = lndService.getOpenChannels();
  const pendingChannels = await lndService.getPendingChannels();

  const allChannels = [];

  // Combine all pending channel types
  for (const channel of pendingChannels.waitingCloseChannels) {
    (<WaitingCloseChannel_extended>channel).type = "WAITING_CLOSING_CHANNEL";
    allChannels.push(channel);
  }

  for (const channel of pendingChannels.pendingForceClosingChannels) {
    (<PendingForceClosedChannel_extended>channel).type =
      "FORCE_CLOSING_CHANNEL";
    allChannels.push(channel);
  }

  for (const channel of pendingChannels.pendingOpenChannels) {
    (<PendingOpenChannel_extended>channel).type = "PENDING_OPEN_CHANNEL";

    // Make our best guess as to if this channel was created by us.
    if (channel.channel?.initiator === Initiator.INITIATOR_LOCAL) {
      (<PendingOpenChannel_extended>channel).initiator = true;
    } else {
      (<PendingOpenChannel_extended>channel).initiator = false;
    }

    switch (channel.channel?.initiator) {
      case Initiator.INITIATOR_LOCAL:
        (<PendingOpenChannel_extended>channel).initiatorText = "Your node";
        break;
      case Initiator.INITIATOR_REMOTE:
        (<PendingOpenChannel_extended>channel).initiatorText = "Remote peer";
        break;
      case Initiator.INITIATOR_BOTH:
        (<PendingOpenChannel_extended>channel).initiatorText = "Both your node and remote peer";
        break;
      default:
        (<PendingOpenChannel_extended>channel).initiatorText = "Unknown";
        break;
    }

    /*// Include commitFee in balance. This helps us avoid the leaky sats issue by making balances more consistent.
    if (channel.channel?.initiator === Initiator.INITIATOR_LOCAL || channel.channel?.initiator === Initiator.INITIATOR_BOTH) {
      channel.channel.localBalance =
        (BigInt(channel.channel?.localBalance || "0") +  BigInt(channel.commitFee)).toString();
    } else {
      channel.channel.remoteBalance =
      (BigInt(channel.channel?.remoteBalance || "0") + BigInt(channel.commitFee)).toString();
    }*/

    allChannels.push(channel);
  }

  // If we have any pending channels, we need to call get chain transactions to determine how many confirmations are
  // left for each pending channel. This gets the entire history of on chain transactions.
  // TODO: Once pagination is available, we should develop a different strategy.
  let chainTxnCall: Promise<Transaction[]> | null = null;
  let chainTxns: Record<string, Transaction> | null = null;
  if (allChannels.length > 0) {
    chainTxnCall = lndService.getOnChainTransactions();
  }

  // Combine open channels
  const openChannels = (await openChannelsCall) as Channel_extended[];

  for (const channel of openChannels) {
    channel.type = "OPEN";

    /*// Include commitFee in balance. This helps us avoid the leaky sats issue by making balances more consistent.
    if (channel.initiator) {
      channel.localBalance = (
        BigInt(channel.localBalance) + BigInt(channel.commitFee)
      ).toString();
    } else {
      channel.remoteBalance = (
        BigInt(channel.remoteBalance) + BigInt(channel.commitFee)
      ).toString();
    }*/

    allChannels.push(channel);
  }

  if (chainTxnCall !== null) {
    const chainTxnList = await chainTxnCall;

    // Convert list to object for efficient searching
    chainTxns = {};
    for (const txn of chainTxnList) {
      chainTxns[txn.txHash] = txn;
    }
  }

  // Iterate through all channels
  // TODO: Proper Typing
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const channel of allChannels as any[]) {
    // Pending channels have an inner channel object.
    if (channel.channel) {
      // Use remotePubkey for consistency with open channels
      channel.remotePubkey = channel.channel.remoteNodePub;
      channel.channelPoint = channel.channel.channelPoint;
      channel.capacity = channel.channel.capacity;
      channel.localBalance = channel.channel.localBalance;
      channel.remoteBalance = channel.channel.remoteBalance;

      delete channel.channel;

      // Determine the number of confirmation remaining for this channel

      // We might have invalid channels that dne in the onChainTxList. Skip these channels
      const knownChannel = chainTxns
        ? chainTxns[getTxnHashFromChannelPoint(channel.channelPoint)]
        : null;
      if (!knownChannel) {
        channel.managed = false;
        channel.name = "";
        channel.purpose = "";

        continue;
      }
      const numConfirmations = knownChannel.numConfirmations;

      if (channel.type === "FORCE_CLOSING_CHANNEL") {
        // BlocksTilMaturity is provided by Lnd for forced closing channels once they have one confirmation
        channel.remainingConfirmations = channel.blocksTilMaturity;
      } else if (channel.type === "PENDING_CLOSING_CHANNEL") {
        // Lnd seams to be clearing these channels after just one confirmation and thus they never exist in this state.
        // Defaulting to 1 just in case.
        channel.remainingConfirmations = 1;
      } else if (channel.type === "PENDING_OPEN_CHANNEL") {
        channel.remainingConfirmations = (
          BigInt(constants.LN_REQUIRED_CONFIRMATIONS) - BigInt(numConfirmations)
        ).toString();
      }
    }

    // Fetch remote node alias and set it
    const alias = await getNodeAlias(channel.remotePubkey);
    channel.remoteAlias = alias || "";
  }

  return allChannels as unknown as Channel_extended[];
}

// Returns a list of all outgoing payments.
export async function getPayments(): Promise<Payment[]> {
  const payments = await lndService.getPayments();

  const reversedPayments = [];
  for (const payment of payments.payments) {
    reversedPayments.unshift(payment);
  }

  return reversedPayments;
}

// Returns the full channel details of a pending channel.
export async function getPendingChannelDetails(
  channelType: pendingChannelTypes,
  pubKey: string
): Promise<PendingChannelsResponse_PendingChannel> {
  const pendingChannels = await getPendingChannels();

  // make sure correct type is used
  if (!PENDING_CHANNEL_TYPES.includes(channelType)) {
    throw Error("unknown pending channel type: " + channelType);
  }
  const typePendingChannel = pendingChannels[channelType];

  for (let index = 0; index < typePendingChannel.length; index++) {
    const curChannel = typePendingChannel[index];
    if (
      curChannel.channel &&
      curChannel.channel.remoteNodePub &&
      curChannel.channel.remoteNodePub === pubKey
    ) {
      return curChannel.channel;
    }
  }

  throw new Error("Could not find a pending channel for pubKey: " + pubKey);
}

// Returns a list of all pending channels.
export async function getPendingChannels(): Promise<PendingChannelsResponse> {
  return await lndService.getPendingChannels();
}

// Returns all associated public uris for this node.
export async function getPublicUris(): Promise<string[]> {
  return await lndService.getInfo().then((info) => info.uris);
}

export async function getGeneralInfo(): Promise<GetInfoResponse> {
  return await lndService.getInfo();
}

// Returns the status on lnd syncing to the current chain.
// LND info returns "best_header_timestamp" from getInfo which is the timestamp of the latest Bitcoin block processed
// by LND. Using known date of the genesis block to roughly calculate a percent processed.
export async function getSyncStatus(): Promise<{
  percent: string;
  knownBlockCount: number;
  processedBlocks: number;
}> {
  const info = await lndService.getInfo();

  let percentSynced = null;
  let processedBlocks = null;

  if (!info.syncedToChain) {
    const genesisTimestamp =
      info.chains[0].network == "testnet"
        ? TESTNET_GENESIS_BLOCK_TIMESTAMP
        : MAINNET_GENESIS_BLOCK_TIMESTAMP;

    const currentTime = BigInt(Math.floor(new Date().getTime() / 1000));

    percentSynced =
      (BigInt(info.bestHeaderTimestamp) - genesisTimestamp) /
      (currentTime - genesisTimestamp);

    // let's not return a value over the 100% or when processedBlocks > blockHeight
    if (percentSynced < BigInt(1.0)) {
      processedBlocks = Math.floor(
        Number(percentSynced) * parseInt(info.blockHeight as string, 10)
      );
    } else {
      processedBlocks = info.blockHeight;
      percentSynced = 1;
    }
  } else {
    percentSynced = 1;
    processedBlocks = info.blockHeight;
  }

  return {
    percent: Number(percentSynced).toFixed(4),
    knownBlockCount: Number(info.blockHeight),
    processedBlocks: Number(processedBlocks),
  };
}

// Returns the wallet balance and pending confirmation balance.
export async function getWalletBalance(): Promise<WalletBalanceResponse> {
  return await lndService.getWalletBalance();
}

// Creates and initialized a Lightning wallet.
export async function initializeWallet(seed: string[]): Promise<void> {
  try {
    await lndService.initWallet(seed);
    return;
  } catch {
    throw new NodeError(
      "Lnd is not operational, therefore a wallet cannot be created."
    );
  }
}

// Opens a channel to the node with the given public key with the given amount.
export async function openChannel(
  pubKey: string,
  ip: string,
  port: number | string,
  amt: string | number,
  satPerByte: number | undefined
): Promise<string> {
  const peers = await lndService.getPeers();

  let existingPeer = false;

  for (const peer of peers) {
    if (peer.pubKey === pubKey) {
      existingPeer = true;
      break;
    }
  }

  if (!existingPeer) {
    await lndService.connectToPeer(pubKey, ip, port);
  }

  if (typeof amt === "string") amt = parseInt(amt);
  // only returns a transactions id
  const channel = await (
    await lndService.openChannel(pubKey, amt, satPerByte)
  ).fundingTxidStr;

  return <string>channel;
}

// Pays the given invoice.
export async function payInvoice(
  paymentRequest: string,
  amt: number | string,
  comment = ""
): Promise<SendResponse> {
  if(Lnurl.isLightningAddress(paymentRequest) || Lnurl.isLnurl(paymentRequest)) {
    const url = new Lnurl(paymentRequest);
    const payload = await url.requestBolt11FromLnurlPayService(parseInt(amt as string), comment);
    console.log(`Decoded ${paymentRequest} to ${payload.pr}`);
    paymentRequest = payload.pr;
  }

  const invoice = await decodePaymentRequest(paymentRequest);

  if (invoice.numSatoshis !== 0 && amt) {
    // numSatoshis is returned from lnd as a string
    throw new NodeError(
      "Payment Request with non zero amount and amt value supplied."
    );
  }

  if (invoice.numSatoshis === 0 && !amt) {
    // numSatoshis is returned from lnd as a string
    throw new NodeError(
      "Payment Request with zero amount requires an amt value supplied."
    );
  }

  if (typeof amt === "string") amt = parseInt(amt);
  return await lndService.sendPaymentSync(paymentRequest, amt);
}

// Send bitcoins on chain to the given address with the given amount. Sats per byte is optional.
export function sendCoins(
  addr: string,
  amt: string | number,
  satPerByte: string | number,
  sendAll: boolean
): Promise<SendCoinsResponse> {
  if (typeof satPerByte === "string") satPerByte = parseInt(satPerByte);
  // Lnd requires we ignore amt if sendAll is true.
  if (sendAll) {
    return lndService.sendCoins(addr, undefined, satPerByte, sendAll);
  }

  if (typeof amt === "string") amt = parseInt(amt);
  return lndService.sendCoins(addr, amt, satPerByte, sendAll);
}

// Returns if lnd is operation and if the wallet is unlocked.
export async function getStatus(): Promise<{
  operational: boolean;
  unlocked: boolean;
}> {
  try {
    // The getInfo function requires that the wallet be unlocked in order to succeed. Lnd requires this for all
    // encrypted wallets.
    await lndService.getInfo();

    return {
      operational: true,
      unlocked: true,
    };
  } catch (error) {
    return {
      operational: await lndService.isOperational(),
      unlocked: false,
    };
  }
}

export async function getVersion(): Promise<string> {
  return await lndService.getVersion();
}

export async function getNodeAlias(pubkey: string): Promise<string> {
  const includeChannels = false;
  let nodeInfo;
  try {
    nodeInfo = await lndService.getNodeInfo(pubkey, includeChannels);
  } catch (error) {
    return "";
  }
  return nodeInfo.node?.alias || "";
}

export async function updateChannelPolicy(
  global: boolean,
  fundingTxid: string | undefined,
  outputIndex: number | undefined,
  baseFeeMsat: number,
  feeRate: number,
  timeLockDelta: number
): Promise<void> {
  await lndService.updateChannelPolicy(
    global,
    fundingTxid,
    outputIndex,
    baseFeeMsat,
    feeRate,
    timeLockDelta
  );
}

export async function signMessage(message: string): Promise<string> {
  return await lndService.signMessage(message);
}

export async function verifyMessage(message: string, signature: string): Promise<{
  pubkey: string;
  valid: boolean;
}> {
  return await lndService.verifyMessage(message, signature);
}

export async function getInvoice(paymentHash: string) {
  return await lndService.getInvoice(paymentHash);
}
