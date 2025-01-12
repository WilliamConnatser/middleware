import * as fs from "@runcitadel/fs";

import { createChannel, createClient, Client } from "nice-grpc";
import {
  Channel,
  ChannelBalanceResponse,
  ChannelCloseSummary,
  ChannelPoint,
  ConnectPeerResponse,
  EstimateFeeResponse,
  FeeReportResponse,
  ForwardingHistoryResponse,
  GetInfoResponse,
  Invoice,
  LightningDefinition,
  ListInvoiceResponse,
  ListPaymentsResponse,
  ListUnspentResponse,
  NewAddressResponse,
  NodeInfo,
  OpenChannelRequest,
  Peer,
  PendingChannelsResponse,
  PolicyUpdateRequest,
  SendCoinsRequest,
  SendCoinsResponse,
  SendResponse,
  Transaction,
  WalletBalanceResponse,
} from "../../lnrpc/lightning.js";
import {
  GenSeedResponse,
  WalletUnlockerDefinition,
} from "../../lnrpc/walletunlocker.js";
import { StateDefinition, WalletState } from "../../lnrpc/stateservice.js";
import * as grpc from "@grpc/grpc-js";
import ILightningClient, { extendedPaymentRequest } from "./abstract.js";

type RpcClientInfo = {
  Lightning?: Client<typeof LightningDefinition>;
  WalletUnlocker: Client<typeof WalletUnlockerDefinition>;
  State: Client<typeof StateDefinition>;
  state: WalletState;
  offline?: boolean;
};

type RpcClientWithLightningForSure = RpcClientInfo & {
  Lightning: Client<typeof LightningDefinition>;
};

const DEFAULT_RECOVERY_WINDOW = 250;

export default class LNDService implements ILightningClient {
  #wasOnline = false;
  #channel: grpc.Channel | undefined = undefined;
  constructor(
    private connectionUrl: string,
    private cert: Buffer,
    private macaroonFile: string
  ) {}

  protected async getCommunicationChannel(): Promise<grpc.Channel> {
    if (this.#channel) return this.#channel;
    const tlsCredentials = grpc.credentials.createSsl(this.cert);
    // Read macaroons, they should exist in this state
    const macaroon = await fs.readFile(this.macaroonFile);

    // build credentials from macaroons
    const metadata = new grpc.Metadata();
    metadata.add("macaroon", macaroon.toString("hex"));
    const macaroonCreds = grpc.credentials.createFromMetadataGenerator(
      (_args, callback) => {
        callback(null, metadata);
      }
    );
    const fullCredentials = grpc.credentials.combineChannelCredentials(
      tlsCredentials,
      macaroonCreds
    );

    this.#channel = createChannel(this.connectionUrl, fullCredentials);
    return this.#channel;
  }

  protected async initializeRPCClient(): Promise<RpcClientInfo> {
    // Create credentials
    const lndCert = this.cert;
    const tlsCredentials = grpc.credentials.createSsl(lndCert);
    const channel = createChannel(this.connectionUrl, tlsCredentials);

    const walletUnlocker = createClient(WalletUnlockerDefinition, channel);

    const stateService = createClient(StateDefinition, channel);

    let walletState;
    try {
      walletState = await stateService.getState({});
    } catch {
      return {
        WalletUnlocker: walletUnlocker,
        State: stateService,
        state: WalletState.NON_EXISTING,
        offline: true,
      };
    }

    /* WAIING_TO_START will be used in the future
     * https://github.com/Lightningnetwork/lnd/blob/bb5c3f3b51c7c58296d120d5afe4ed0640d5751e/docs/leader_election.md
     * Once we have stuff like that implemented on the Citadel dashboard
     */
    if (
      walletState.state == WalletState.NON_EXISTING ||
      walletState.state == WalletState.LOCKED ||
      walletState.state == WalletState.WAITING_TO_START
    ) {
      return {
        WalletUnlocker: walletUnlocker,
        State: stateService,
        state: walletState.state,
      };
    } else if (
      walletState.state == WalletState.RPC_ACTIVE ||
      walletState.state == WalletState.SERVER_ACTIVE
    ) {
      const authenticatedChannel = await this.getCommunicationChannel();

      const LightningClient: Client<typeof LightningDefinition> = createClient(
        LightningDefinition,
        authenticatedChannel
      );

      this.#wasOnline = true;

      return {
        WalletUnlocker: walletUnlocker,
        State: stateService,
        Lightning: LightningClient,
        state: walletState.state,
      };
    } else {
      throw new Error("Unexpected LND state!");
    }
  }

  protected async expectWalletToExist(): Promise<RpcClientWithLightningForSure> {
    const client = await this.initializeRPCClient();
    if (!client.Lightning) throw new Error("Error: Wallet not ready");
    return client as RpcClientWithLightningForSure;
  }

  protected async getLightningClient(): Promise<
    Client<typeof LightningDefinition>
  > {
    if (this.#wasOnline) {
      const channel = await this.getCommunicationChannel();
      return createClient(LightningDefinition, channel);
    } else {
      const client = await this.expectWalletToExist();
      return client.Lightning;
    }
  }

  // an amount, an options memo, and can only be paid to node that created it.
  async addInvoice(
    amount: number | string,
    memo: string
  ): Promise<{
    rHash: Uint8Array;
    paymentRequest: string;
  }> {
    amount = amount.toString();
    const rpcPayload = {
      value: amount,
      memo,
      expiry: "3600",
    };

    const Lightning = await this.getLightningClient();

    const grpcResponse = await Lightning.addInvoice(rpcPayload);

    if (grpcResponse && grpcResponse.paymentRequest) {
      return {
        rHash: grpcResponse.rHash,
        paymentRequest: grpcResponse.paymentRequest,
      };
    } else {
      throw new Error("Unable to parse invoice from lnd");
    }
  }

  async closeChannel(
    fundingTxId: string,
    index: number,
    force: boolean
  ): Promise<void> {
    const rpcPayload = {
      channelPoint: {
        fundingTxidStr: fundingTxId,
        outputIndex: index,
      },
      force,
    };

    const Lightning = await this.getLightningClient();
    const call = Lightning.closeChannel(rpcPayload);
    for await (const data of call) {
      if (data.closePending) {
        return;
      }
    }
  }

  // Connects this lnd node to a peer.
  async connectToPeer(
    pubKey: string,
    ip: string,
    port: number | string
  ): Promise<ConnectPeerResponse> {
    const rpcPayload = {
      addr: {
        pubkey: pubKey,
        host: `${ip}:${port}`,
      },
    };

    const Lightning = await this.getLightningClient();
    return await Lightning.connectPeer(rpcPayload);
  }

  async decodePaymentRequest(
    paymentRequest: string
  ): Promise<extendedPaymentRequest> {
    const rpcPayload = {
      payReq: paymentRequest,
    };

    const Lightning = await this.getLightningClient();
    const invoice: extendedPaymentRequest = await Lightning.decodePayReq(
      rpcPayload
    );
    // add on payment request for extra details
    invoice.paymentRequest = paymentRequest;
    return invoice;
  }

  async estimateFee(
    address: string,
    amt: number | string,
    confTarget: number
  ): Promise<EstimateFeeResponse> {
    const addrToAmount: { [key: string]: string } = {};
    addrToAmount[address] = amt.toString();

    const rpcPayload = {
      AddrToAmount: addrToAmount,
      targetConf: confTarget,
    };

    const Lightning = await this.getLightningClient();

    return await Lightning.estimateFee(rpcPayload);
  }

  async generateAddress(): Promise<NewAddressResponse> {
    const rpcPayload = {
      type: 0,
    };

    const Lightning = await this.getLightningClient();

    return await Lightning.newAddress(rpcPayload);
  }

  async generateSeed(): Promise<GenSeedResponse> {
    const { WalletUnlocker, state } = await this.initializeRPCClient();
    if (state !== WalletState.NON_EXISTING) {
      throw new Error("Wallet already exists");
    }
    return await WalletUnlocker.genSeed({});
  }

  async getChannelBalance(): Promise<ChannelBalanceResponse> {
    const Lightning = await this.getLightningClient();
    return Lightning.channelBalance({});
  }

  async getFeeReport(): Promise<FeeReportResponse> {
    const Lightning = await this.getLightningClient();
    return await Lightning.feeReport({});
  }

  async getForwardingEvents(
    startTime: number | string,
    endTime: number | string,
    indexOffset: number
  ): Promise<ForwardingHistoryResponse> {
    const rpcPayload = {
      startTime: startTime.toString(),
      endTime: endTime.toString(),
      indexOffset,
      // TODO: Probably make this dynamic and reduce the default
      numMaxEvents: 5000,
    };

    const Lightning = await this.getLightningClient();
    return await Lightning.forwardingHistory(rpcPayload);
  }

  async isOperational(): Promise<boolean> {
    return !(await this.initializeRPCClient()).offline;
  }

  async getInfo(): Promise<GetInfoResponse> {
    const Lightning = await this.getLightningClient();
    return await Lightning.getInfo({});
  }

  async getNodeInfo(
    pubKey: string,
    includeChannels: boolean
  ): Promise<NodeInfo> {
    const rpcPayload = {
      pubKey,
      includeChannels,
    };
    const Lightning = await this.getLightningClient();
    return await Lightning.getNodeInfo(rpcPayload);
  }

  // Returns a list of lnd's currently open channels. Channels are considered open by this node and it's directly
  // connected peer after three confirmation. After six confirmations, the channel is broadcasted by this node and it's
  // directly connected peer to the broader Lightning network.
  async getOpenChannels(): Promise<Channel[]> {
    const Lightning = await this.getLightningClient();
    const grpcResponse = await Lightning.listChannels({});
    return grpcResponse.channels;
  }

  async getClosedChannels(): Promise<ChannelCloseSummary[]> {
    const Lightning = await this.getLightningClient();
    const grpcResponse = await Lightning.closedChannels({});
    return grpcResponse.channels;
  }

  // Returns a list of all outgoing payments.
  async getPayments(): Promise<ListPaymentsResponse> {
    const Lightning = await this.getLightningClient();
    return await Lightning.listPayments({});
  }

  // Returns a list of all lnd's currently connected and active peers.
  async getPeers(): Promise<Peer[]> {
    const Lightning = await this.getLightningClient();
    const grpcResponse = await Lightning.listPeers({});
    if (grpcResponse && grpcResponse.peers) {
      return grpcResponse.peers;
    } else {
      throw new Error("Unable to parse peer information");
    }
  }

  // Returns a list of lnd's currently pending channels. Pending channels include, channels that are in the process of
  // being opened, but have not reached three confirmations. Channels that are pending closed, but have not reached
  // one confirmation. Forced close channels that require potentially hundreds of confirmations.
  async getPendingChannels(): Promise<PendingChannelsResponse> {
    const Lightning = await this.getLightningClient();
    return await Lightning.pendingChannels({});
  }

  async getWalletBalance(): Promise<WalletBalanceResponse> {
    console.log(this);
    console.log(this.expectWalletToExist);
    const Lightning = await this.getLightningClient();
    return await Lightning.walletBalance({});
  }

  async initWallet(mnemonic: string[]): Promise<string[]> {
    const passwordBuff = Buffer.from("moneyprintergobrrr", "utf8");

    const rpcPayload = {
      walletPassword: passwordBuff,
      cipherSeedMnemonic: mnemonic,
      recoveryWindow: DEFAULT_RECOVERY_WINDOW,
    };

    const { WalletUnlocker, state } = await this.initializeRPCClient();
    if (state !== WalletState.NON_EXISTING) {
      throw new Error("Wallet already exists");
    }
    await WalletUnlocker.initWallet(rpcPayload);
    return mnemonic;
  }

  // Returns a list of all invoices.
  async getInvoices(): Promise<ListInvoiceResponse> {
    const rpcPayload = {
      reversed: true, // Returns most recent
      numMaxInvoices: "100",
    };

    const Lightning = await this.getLightningClient();
    return await Lightning.listInvoices(rpcPayload);
  }

  async getInvoice(paymentHash: string): Promise<Invoice> {
    const Lightning = await this.getLightningClient();
    return await Lightning.lookupInvoice({ rHashStr: paymentHash });
  }

  // Returns a list of all on chain transactions.
  async getOnChainTransactions(): Promise<Transaction[]> {
    const Lightning = await this.getLightningClient();
    const grpcResponse = await Lightning.getTransactions({});
    return grpcResponse.transactions;
  }

  async listUnspent(): Promise<ListUnspentResponse> {
    const rpcPayload = {
      minConfs: 1,
      maxConfs: 10000000, // Use arbitrarily high maximum confirmation limit.
    };

    const Lightning = await this.getLightningClient();

    return await Lightning.listUnspent(rpcPayload);
  }

  async openChannel(
    pubKey: string,
    amt: number,
    satPerVbyte: number | undefined
  ): Promise<ChannelPoint> {
    const rpcPayload: OpenChannelRequest = {
      nodePubkeyString: pubKey,
      localFundingAmount: amt.toString(),
    } as OpenChannelRequest;

    if (satPerVbyte) {
      rpcPayload.satPerVbyte = satPerVbyte.toString();
    } else {
      rpcPayload.targetConf = 6;
    }

    const Lightning = await this.getLightningClient();
    return await Lightning.openChannelSync(rpcPayload);
  }

  async sendCoins(
    addr: string,
    amt: number | undefined,
    satPerVbyte: number,
    sendAll: boolean
  ): Promise<SendCoinsResponse> {
    const rpcPayload: SendCoinsRequest = {
      addr,
      amount: amt?.toString(),
      sendAll,
    } as SendCoinsRequest;

    if (satPerVbyte) {
      rpcPayload.satPerVbyte = satPerVbyte.toString();
    } else {
      rpcPayload.targetConf = 6;
    }

    const Lightning = await this.getLightningClient();
    return await Lightning.sendCoins(rpcPayload);
  }

  async sendPaymentSync(
    paymentRequest: string,
    amt: number
  ): Promise<SendResponse> {
    const rpcPayload: {
      paymentRequest: string;
      amt?: string;
    } = {
      paymentRequest,
    };

    if (amt) rpcPayload.amt = amt.toString();

    const Lightning = await this.getLightningClient();
    const response = await Lightning.sendPaymentSync(rpcPayload);
    // sometimes the error comes in on the response...
    if (response.paymentError) {
      throw new Error(
        `Unable to send Lightning payment: ${response.paymentError}`
      );
    }
    return response;
  }

  async updateChannelPolicy(
    global: boolean,
    fundingTxid: string,
    outputIndex: number,
    baseFeeMsat: number,
    feeRate: number,
    timeLockDelta: number
  ): Promise<void> {
    const rpcPayload: PolicyUpdateRequest = {
      baseFeeMsat: baseFeeMsat.toString(),
      feeRate,
      timeLockDelta,
      minHtlcMsatSpecified: false,
    } as PolicyUpdateRequest;

    if (global) {
      rpcPayload.global = global;
    } else {
      rpcPayload.chanPoint = <ChannelPoint>{
        fundingTxidStr: fundingTxid,
        outputIndex,
      };
    }

    const Lightning = await this.getLightningClient();
    await Lightning.updateChannelPolicy(rpcPayload);
  }

  async getVersion(): Promise<string> {
    const info = await this.getInfo();
    return info.version;
  }

  async signMessage(message: string): Promise<string> {
    const Lightning = await this.getLightningClient();
    // message as an Uint8Array
    const msg = Uint8Array.from(Buffer.from(message, "utf8"));
    const response = await Lightning.signMessage({ msg });
    return response.signature;
  }

  async verifyMessage(
    message: string,
    signature: string
  ): Promise<{
    pubkey: string;
    valid: boolean;
  }> {
    const Lightning = await this.getLightningClient();
    // message as an Uint8Array
    const msg = Uint8Array.from(Buffer.from(message, "utf8"));
    const response = await Lightning.verifyMessage({ msg, signature });
    return response;
  }
}
