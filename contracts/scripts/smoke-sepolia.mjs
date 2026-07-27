import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
const c = createPublicClient({ chain: sepolia, transport: http("https://ethereum-sepolia-rpc.publicnode.com") });
const POOL = "0xfced18bc0ea5c90b6307f403aa0f21f291b7b7a5";
const UNI  = "0xd35EA7f04Afc631A5A664Ab2dc9420329615D124";
const USDC = "0xb388c8cdf22bd89f0110620a0b557baa5d9d6ef1";
const WETH = "0x3003e7d75477c4f6836ec117f6e9c1202e09da84";
const abi = (sig, outputs) => [{ type:"function", name:sig, inputs:[], outputs, stateMutability:"view" }];
const r = (address, name, outputs) => c.readContract({ address, abi: abi(name, outputs), functionName: name });

const [epochId, twapWindow, dev, minOrders, slip, revealTo, unwrapTo, owner] = await Promise.all([
  r(POOL,"currentEpochId",[{type:"uint256"}]), r(POOL,"twapWindow",[{type:"uint32"}]),
  r(POOL,"maxTickDeviation",[{type:"uint24"}]), r(POOL,"minOrders",[{type:"uint32"}]),
  r(POOL,"maxSlippageBps",[{type:"uint16"}]), r(POOL,"revealTimeout",[{type:"uint64"}]),
  r(POOL,"unwrapTimeout",[{type:"uint64"}]), r(POOL,"owner",[{type:"address"}]),
]);
console.log("KairosPool config");
console.log("  currentEpochId :", epochId, "(1 = first epoch open)");
console.log("  minOrders      :", minOrders, "(privacy floor per side)");
console.log("  maxSlippageBps :", slip);
console.log("  twapWindow     :", twapWindow, "s / maxTickDeviation", dev);
console.log("  revealTimeout  :", revealTo, "s   unwrapTimeout:", unwrapTo, "s");
console.log("  owner          :", owner);

const epochAbi=[{type:"function",name:"getEpoch",inputs:[{type:"uint256"}],outputs:[{type:"tuple",components:[
 {name:"state",type:"uint8"},{name:"residual",type:"uint8"},{name:"startTime",type:"uint64"},{name:"endTime",type:"uint64"},
 {name:"sealedAt",type:"uint64"},{name:"unwrapRequestedAt",type:"uint64"},{name:"buyCount",type:"uint32"},{name:"sellCount",type:"uint32"},
 {name:"revealTimeoutSnap",type:"uint64"},{name:"unwrapTimeoutSnap",type:"uint64"},{name:"minOrdersSnap",type:"uint32"},
 {name:"maxSlippageBpsSnap",type:"uint16"},{name:"auditorSnap",type:"address"},{name:"buyTotalEnc",type:"bytes32"},
 {name:"sellTotalEnc",type:"bytes32"},{name:"unwrapRequestId",type:"bytes32"},{name:"buyTotal",type:"uint256"},
 {name:"sellTotal",type:"uint256"},{name:"residualIn",type:"uint256"},{name:"buyOutTotal",type:"uint256"},{name:"sellOutTotal",type:"uint256"}]}],stateMutability:"view"}];
const e = await c.readContract({address:POOL, abi:epochAbi, functionName:"getEpoch", args:[1n]});
const now = Math.floor(Date.now()/1000);
console.log("\nEpoch 1: state", e.state, "(1=Open)", "| ends in", Number(e.endTime)-now, "s | snapshots minOrders", e.minOrdersSnap, "slippage", e.maxSlippageBpsSnap);

// Uniswap pool health
const slot0Abi=[{type:"function",name:"slot0",inputs:[],outputs:[{type:"uint160"},{type:"int24"},{type:"uint16"},{type:"uint16"},{type:"uint16"},{type:"uint8"},{type:"bool"}],stateMutability:"view"}];
const [slot0, liq] = await Promise.all([
  c.readContract({address:UNI,abi:slot0Abi,functionName:"slot0"}),
  r(UNI,"liquidity",[{type:"uint128"}]),
]);
const bal = (t) => c.readContract({address:t, abi:[{type:"function",name:"balanceOf",inputs:[{type:"address"}],outputs:[{type:"uint256"}],stateMutability:"view"}], functionName:"balanceOf", args:[UNI]});
const [pu, pw] = await Promise.all([bal(USDC), bal(WETH)]);
console.log("\nUniswap pool");
console.log("  liquidity      :", liq);
console.log("  reserves       :", Number(pu)/1e6, "tUSDC /", Number(pw)/1e18, "tWETH");
console.log("  observations   : cardinality", slot0[3], "(next", slot0[4]+")");

// TWAP guard live check
const obsAbi=[{type:"function",name:"observe",inputs:[{type:"uint32[]"}],outputs:[{type:"int56[]"},{type:"uint160[]"}],stateMutability:"view"}];
try {
  const [tc] = await c.readContract({address:UNI,abi:obsAbi,functionName:"observe",args:[[120,0]]});
  const twapTick = Number((tc[1]-tc[0])/120n);
  console.log("  spot tick", slot0[1], "| 120s TWAP tick", twapTick, "| deviation", Math.abs(slot0[1]-twapTick), "(limit 200) ->", Math.abs(slot0[1]-twapTick)<=200 ? "GUARD PASSES" : "GUARD WOULD BLOCK");
} catch (err) { console.log("  observe(120s) FAILED — oracle history not deep enough yet:", err.shortMessage||err.message); }
