import {
  ChangedPhase as ChangedPhaseEvent,
  Deposit as DepositEvent,
  Withdraw as WithdrawEvent,
  CreatedInvestment as CreatedInvestmentEvent,
  SoldInvestment as SoldInvestmentEvent,
  CreatedCompoundOrder as CreatedCompoundOrderEvent,
  SoldCompoundOrder as SoldCompoundOrderEvent,
  RepaidCompoundOrder as RepaidCompoundOrderEvent,
  CommissionPaid as CommissionPaidEvent,
  TotalCommissionPaid as TotalCommissionPaidEvent,
  Register as RegisterEvent,
  SignaledUpgrade as SignaledUpgradeEvent,
  DeveloperInitiatedUpgrade as DeveloperInitiatedUpgradeEvent,
  InitiatedUpgrade as InitiatedUpgradeEvent,
  ProposedCandidate as ProposedCandidateEvent,
  Voted as VotedEvent,
  FinalizedNextVersion as FinalizedNextVersionEvent,
  OwnershipTransferred as OwnershipTransferredEvent,
  BetokenFund
} from "../../generated/BetokenFund/BetokenFund"

import { KyberNetwork } from "../../generated/KyberNetwork/KyberNetwork"

import {
  Manager,
  BasicOrder,
  CompoundOrder,
  FulcrumOrder,
  CommissionRedemption,
  Investor,
  DepositWithdraw,
  Fund,
  DataPoint
} from "../../generated/schema"

import { CompoundOrderContract } from '../../generated/BetokenFund/templates/CompoundOrderContract/CompoundOrderContract'
import { PositionToken } from '../../generated/BetokenFund/templates/PositionToken/PositionToken'
import { MiniMeToken } from '../../generated/BetokenFund/templates/MiniMeToken/MiniMeToken'

import { BigInt, Address, EthereumEvent } from '@graphprotocol/graph-ts'

enum CyclePhase {
  INTERMISSION,
  MANAGE
}

enum VoteDirection {
  EMPTY,
  FOR,
  AGAINST
}

// Constants

import {PTOKENS} from '../fulcrum_tokens'
let RISK_THRESHOLD_TIME = BigInt.fromI32(3 * 24 * 60 * 60) // 3 days, in seconds
let ZERO = BigInt.fromI32(0)
let CALLER_REWARD = tenPow(18) // 10 ** 18 or 1 KRO
let PRECISION = tenPow(18)
let KYBER_ADDR = Address.fromString("0x818E6FECD516Ecc3849DAf6845e3EC868087B755")
let DAI_ADDR = Address.fromString("0x89d24A6b4CcB1B6fAA2625fE562bDD9a23260359")

// Helpers

function isUndefined(x: any): boolean { return x == null }

function isFulcrumTokenAddress(_tokenAddress: string): boolean {
  const result = PTOKENS.find((x) => !isUndefined(x.pTokens.find((y) => y.address === _tokenAddress)));
  return !isUndefined(result);
}

function assetPTokenAddressToInfo(_addr: string): object {
  return PTOKENS.find((x) => !isUndefined(x.pTokens.find((y) => y.address === _addr))).pTokens.find((y) => y.address === _addr);
}

function updateTotalFunds(fundAddress: Address, event: EthereumEvent): void {
  let fund = Fund.load("")
  let fundContract = BetokenFund.bind(fundAddress)
  let kairo = kairoContract(fundAddress)
  let shares = sharesContract(fundAddress)
  fund.totalFundsInDAI = fundContract.totalFundsInDAI()
  fund.kairoPrice = fundContract.kairoPrice()
  fund.kairoTotalSupply = kairo.totalSupply()
  fund.sharesPrice = fund.totalFundsInDAI.times(PRECISION).div(shares.totalSupply())
  fund.sharesTotalSupply = shares.totalSupply()

  let dp = new DataPoint(event.transaction.hash.toHex() + "-" + event.logIndex.toString())
  dp.timestamp = event.block.timestamp
  dp.value = fund.sharesPrice
  dp.save()

  fund.sharesPriceHistory.push(dp.id)
  fund.save()
}

function tenPow(exponent: number): BigInt {
  let result = BigInt.fromI32(1)
  for (let i = 0; i < exponent; i++) {
    result = result.times(BigInt.fromI32(10))
  }
  return result
}

function getPriceOfToken(tokenAddress: Address): BigInt {
  let kyber = KyberNetwork.bind(KYBER_ADDR)
  let result = kyber.getExpectedRate(tokenAddress, DAI_ADDR, tenPow(15))
  return result.value1
}

function kairoContract(fundAddress: Address): MiniMeToken {
  let fund = BetokenFund.bind(fundAddress)
  return MiniMeToken.bind(fund.controlTokenAddr())
}

function sharesContract(fundAddress: Address): MiniMeToken {
  let fund = BetokenFund.bind(fundAddress)
  return MiniMeToken.bind(fund.shareTokenAddr())
}

// Handlers

export function handleChangedPhase(event: ChangedPhaseEvent): void {
  let entity = Fund.load("");
  let fund = BetokenFund.bind(event.address)
  entity.cycleNumber = event.params._cycleNumber
  entity.cyclePhase = CyclePhase[event.params._newPhase.toI32()]
  entity.startTimeOfCyclePhase = event.block.timestamp
  if (!fund.hasFinalizedNextVersion()) {
    entity.candidates.length = 0
    entity.proposers.length = 0
    entity.forVotes.length = 0
    entity.againstVotes.length = 0
    entity.upgradeVotingActive = false
    entity.upgradeSignalStrength = ZERO
    entity.nextVersion = ""
  }
  entity.save()

  let caller = Manager.load(event.transaction.from.toHex())
  if (caller != null) {
    caller.kairoBalance = caller.kairoBalance.plus(CALLER_REWARD)
  }
  caller.save()

  for (let m = 0; m < entity.managers.length; m++) {
    let manager = Manager.load(entity.managers[m])
    manager.baseStake = manager.kairoBalance
    manager.riskTaken = ZERO
    manager.riskThreshold = manager.baseStake.times(RISK_THRESHOLD_TIME)
    manager.save()
  }
}

export function handleDeposit(event: DepositEvent): void {
  let entity = new DepositWithdraw(
    event.transaction.hash.toHex() + "-" + event.logIndex.toString()
  )
  entity.amountInDAI = event.params._daiAmount
  entity.timestamp = event.params._timestamp
  entity.isDeposit = true
  entity.txHash = event.transaction.hash.toHex()
  entity.save()

  updateTotalFunds(event.address, event)
}

export function handleWithdraw(event: WithdrawEvent): void {
  let entity = new DepositWithdraw(
    event.transaction.hash.toHex() + "-" + event.logIndex.toString()
  )
  entity.amountInDAI = event.params._daiAmount
  entity.timestamp = event.params._timestamp
  entity.isDeposit = false
  entity.txHash = event.transaction.hash.toHex()
  entity.save()

  updateTotalFunds(event.address, event)
}

export function handleCreatedInvestment(event: CreatedInvestmentEvent): void {
  let id = event.params._id.toString() + '-' + event.params._cycleNumber.toString()
  let entity: BasicOrder | FulcrumOrder
  if (isFulcrumTokenAddress(event.params._tokenAddress.toHex())) {
    entity = new FulcrumOrder(id);
    entity['isShort'] = assetPTokenAddressToInfo(event.params._tokenAddress.toHex())['type'];
  } else {
    entity = new BasicOrder(id);
  }
  entity.idx = event.params._id
  entity.cycleNumber = event.params._cycleNumber
  entity.tokenAddress = event.params._tokenAddress.toHex()
  entity.stake = event.params._stakeInWeis
  entity.buyPrice = event.params._buyPrice
  entity.sellPrice = ZERO
  entity.buyTime = event.block.timestamp
  entity.sellTime = ZERO
  entity.save()

  let manager = Manager.load(event.params._sender.toHex())
  if (isFulcrumTokenAddress(event.params._tokenAddress.toHex())) {
    manager.fulcrumOrders.push(entity.id)
  } else {
    manager.basicOrders.push(entity.id)
  }
  manager.kairoBalance = manager.kairoBalance.minus(entity.stake)
  manager.save()
}

export function handleSoldInvestment(event: SoldInvestmentEvent): void {
  let id = event.params._id.toString() + '-' + event.params._cycleNumber.toString()
  let entity : any
  if (isFulcrumTokenAddress(event.params._tokenAddress.toHex())) {
    entity = FulcrumOrder.load(id);
  } else {
    entity = BasicOrder.load(id);
  }
  entity.isSold = true
  entity.sellTime = event.block.timestamp
  entity.sellPrice = event.params._sellPrice
  entity.save()

  updateTotalFunds(event.address, event)

  let manager = Manager.load(event.params._sender.toHex())
  manager.kairoBalance = manager.kairoBalance.plus(event.params._receivedKairo)
  manager.save()
}

export function handleCreatedCompoundOrder(
  event: CreatedCompoundOrderEvent
): void {
  let id = event.params._id.toString() + '-' + event.params._cycleNumber.toString()
  let entity = new CompoundOrder(id)
  entity.idx = event.params._id
  entity.cycleNumber = event.params._cycleNumber
  entity.tokenAddress = event.params._tokenAddress.toHex()
  entity.stake = event.params._stakeInWeis
  entity.collateralAmountInDAI = event.params._costDAIAmount
  entity.buyTime = event.block.timestamp
  entity.sellTime = ZERO
  entity.isShort = event.params._orderType
  entity.orderAddress = event.params._order.toHex()
  entity.outputAmount = ZERO

  let contract = CompoundOrderContract.bind(event.params._order)
  entity.marketCollateralFactor = contract.getMarketCollateralFactor()
  entity.collateralRatio = contract.getCurrentCollateralRatioInDAI()
  let currProfitObj = contract.getCurrentProfitInDAI() // value0: isNegative, value1: value
  entity.currProfit = currProfitObj.value1.times(currProfitObj.value0 ? BigInt.fromI32(-1) : BigInt.fromI32(1))
  entity.currCollateral = contract.getCurrentCollateralInDAI()
  entity.currBorrow = contract.getCurrentBorrowInDAI()
  entity.currCash = contract.getCurrentCashInDAI()
  entity.save()

  let manager = Manager.load(event.params._sender.toHex())
  manager.compoundOrders.push(entity.id)
  manager.kairoBalance = manager.kairoBalance.minus(entity.stake)
  manager.save()
}

export function handleSoldCompoundOrder(event: SoldCompoundOrderEvent): void {
  let id = event.params._id.toString() + '-' + event.params._cycleNumber.toString()
  let entity = CompoundOrder.load(id)
  entity.isSold = true
  entity.sellTime = event.block.timestamp
  entity.outputAmount = event.params._earnedDAIAmount
  entity.save()

  updateTotalFunds(event.address, event)

  let manager = Manager.load(event.params._sender.toHex())
  manager.kairoBalance = manager.kairoBalance.plus(event.params._receivedKairo)
  manager.save()
}

export function handleCommissionPaid(event: CommissionPaidEvent): void {
  let entity = new CommissionRedemption(
    event.transaction.hash.toHex() + "-" + event.logIndex.toString()
  )
  entity.timestamp = event.block.timestamp
  entity.cycleNumber = event.params._cycleNumber
  entity.amountInDAI = event.params._commission
  entity.txHash = event.transaction.hash.toHex()
  entity.save()

  let manager = Manager.load(event.params._sender.toHex())
  manager.commissionHistory.push(entity.id)
  manager.lastCommissionRedemption = entity.cycleNumber
  manager.save()
}

export function handleTotalCommissionPaid(event: TotalCommissionPaidEvent): void {
  let entity = Fund.load("")
  entity.cycleTotalCommission = event.params._totalCommissionInDAI
  entity.save()
}

export function handleRegister(event: RegisterEvent): void {
  let entity = new Manager(event.params._manager.toHex())
  entity.kairoBalance = event.params._kairoReceived
  entity.kairoBalanceWithStake = event.params._kairoReceived
  entity.baseStake = event.params._kairoReceived
  entity.riskTaken = ZERO
  entity.riskThreshold = entity.baseStake.times(RISK_THRESHOLD_TIME)
  entity.lastCommissionRedemption = ZERO
  entity.upgradeSignal = false
  entity.save()

  updateTotalFunds(event.address, event)
}

export function handleSignaledUpgrade(event: SignaledUpgradeEvent): void {
  let manager = Manager.load(event.params._sender.toHex())
  manager.upgradeSignal = event.params._inSupport
  manager.save()
}

export function handleDeveloperInitiatedUpgrade(
  event: DeveloperInitiatedUpgradeEvent
): void {
  let entity = Fund.load("")
  entity.upgradeVotingActive = true
  entity.nextVersion = event.params._candidate.toHex()
  entity.save()
}

export function handleInitiatedUpgrade(event: InitiatedUpgradeEvent): void {
  let entity = Fund.load("")
  entity.upgradeVotingActive = true
  entity.save()
}

export function handleProposedCandidate(event: ProposedCandidateEvent): void {
  let entity = Fund.load("")
  let fund = BetokenFund.bind(event.address)
  let candidates = new Array<string>(5)
  let proposers = new Array<string>(5)
  for (let i = 0; i < 5; i++) {
    candidates[i] = fund.candidates(BigInt.fromI32(i)).toHex()
    proposers[i] = fund.proposers(BigInt.fromI32(i)).toHex()
  }
  entity.candidates = candidates
  entity.proposers = proposers 
  entity.save()
}

export function handleVoted(event: VotedEvent): void {
  let entity = Fund.load("")
  let fund = BetokenFund.bind(event.address)
  let forVotes = new Array<BigInt>(5)
  let againstVotes = new Array<BigInt>(5)
  for (let i = 0; i < 5; i++) {
    forVotes[i] = fund.forVotes(BigInt.fromI32(i))
    againstVotes[i] = fund.againstVotes(BigInt.fromI32(i))
  }
  entity.forVotes = forVotes
  entity.againstVotes = againstVotes
  entity.save()

  let manager = Manager.load(event.params._sender.toHex())
  let votes = new Array<string>(5)
  for (let i = 0; i < 5; i++) {
    votes[i] = VoteDirection[fund.managerVotes(fund.cycleNumber(), event.params._sender, BigInt.fromI32(i))]
  }
  manager.votes = votes
}

export function handleFinalizedNextVersion(
  event: FinalizedNextVersionEvent
): void {
  let entity = Fund.load("")
  entity.hasFinalizedNextVersion = true
  entity.nextVersion = event.params._nextVersion.toString()
  entity.save()
}

// block handler

import { EthereumBlock } from '@graphprotocol/graph-ts'

export function handleBlock(block: EthereumBlock): void {
  let fund = Fund.load("")
  for (let m = 0; m < fund.managers.length; m++) {
    let manager = Manager.load(fund.managers[m])
    let riskTaken = ZERO
    // basic orders
    for (let o = 0; o < manager.basicOrders.length; o++) {
      let order = BasicOrder.load(manager.basicOrders[o])
      if (order.cycleNumber.equals(fund.cycleNumber)) {
        // update price
        if (!order.isSold) {
          order.sellPrice = getPriceOfToken(Address.fromString(order.tokenAddress))
        }
        // record risk
        if (order.isSold) {
          riskTaken = riskTaken.plus(order.sellTime.minus(order.buyTime).times(manager.baseStake))
        } else {
          riskTaken = riskTaken.plus(block.timestamp.minus(order.buyTime).times(manager.baseStake))
        }
      }
    }

    // Fulcrum orders
    for (let o = 0; o < manager.basicOrders.length; o++) {
      let order = FulcrumOrder.load(manager.basicOrders[o])
      if (order.cycleNumber.equals(fund.cycleNumber)) {
        // update price
        if (!order.isSold) {
          let pToken = PositionToken.bind(Address.fromString(order.tokenAddress))
          order.sellPrice = pToken.tokenPrice()
          order.liquidationPrice = pToken.liquidationPrice()
        }
        // record risk
        if (order.isSold) {
          riskTaken = riskTaken.plus(order.sellTime.minus(order.buyTime).times(manager.baseStake))
        } else {
          riskTaken = riskTaken.plus(block.timestamp.minus(order.buyTime).times(manager.baseStake))
        }
      }
    }

    // Compound orders
    for (let o = 0; o < manager.compoundOrders.length; o++) {
      let order = CompoundOrder.load(manager.compoundOrders[o])
      if (order.cycleNumber.equals(fund.cycleNumber) && !order.isSold) {
        let contract = CompoundOrderContract.bind(Address.fromString(order.orderAddress))
        order.collateralRatio = contract.getCurrentCollateralRatioInDAI()

        let currProfitObj = contract.getCurrentProfitInDAI() // value0: isNegative, value1: value
        order.currProfit = currProfitObj.value1.times(currProfitObj.value0 ? BigInt.fromI32(-1) : BigInt.fromI32(1))

        order.currCollateral = contract.getCurrentCollateralInDAI()
        order.currBorrow = contract.getCurrentBorrowInDAI()
        order.currCash = contract.getCurrentCashInDAI()
        order.save()
      }

      // record risk
      if (order.cycleNumber.equals(fund.cycleNumber)) {
        if (order.isSold) {
          riskTaken = riskTaken.plus(order.sellTime.minus(order.buyTime).times(manager.baseStake))
        } else {
          riskTaken = riskTaken.plus(block.timestamp.minus(order.buyTime).times(manager.baseStake))
        }
      }
    }

    // risk taken
    manager.riskTaken = riskTaken
  }
}