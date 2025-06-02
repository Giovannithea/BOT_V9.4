/*──────────────────────────────────────────────────────────────
  newRaydiumLpService.js  –  BOT 9.3
  One‑hop, in‑memory return flow **while still persisting every
  LP document to MongoDB**.  We now pass the Mongo _id back as
  `tokenId` and leave the rest of the object untouched.
──────────────────────────────────────────────────────────────*/

const { Connection, PublicKey, Keypair } = require("@solana/web3.js");
const { MongoClient }          = require("mongodb");
const bs58                     = require("bs58");
const { getAssociatedTokenAddressSync } = require("@solana/spl-token");
require("dotenv").config();

// ──────────────────────────────────────────────────────────
// Constants / singletons
const connection               = new Connection(process.env.SOLANA_WS_URL, "confirmed");
const RAYDIUM_AMM_PROGRAM_ID   = new PublicKey(process.env.RAYDIUM_AMM_PROGRAM_ID);
const SYSTEM_PROGRAM_ID        = "11111111111111111111111111111111";
const TOKEN_PROGRAM_ID_STR     = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ASSOCIATED_TOKEN_PROGRAM_ID_STR = "ATokenGPv1sfdS5qUnx9GbS6hX1TTjR1L6rT3HaZJFA";
const WSOL_MINT               = "So11111111111111111111111111111112";

// ──────────────────────────────────────────────────────────
// Mongo helpers
let db;

async function connectToDatabase() {
    const client = new MongoClient(process.env.MONGO_URI);
    try {
        await client.connect();
        db = client.db("bot");
        console.log("Connected to MongoDB successfully.");
    } catch (error) {
        console.error("MongoDB connection failed:", error.message);
        process.exit(1);
    }
}

async function saveToMongo(tokenData) {
    if (!db) throw new Error("Database connection not initialized");
    const result = await db.collection("raydium_lp_transactionsV3").insertOne(tokenData);
    console.log("Saved document with ID:", result.insertedId);
    return result;           // { acknowledged, insertedId }
}

// ──────────────────────────────────────────────────────────
// Binary helpers
function parseCreateAmmLpParams(data) {
    return {
        discriminator : data.readUInt8(0),
        nonce         : data.readUInt8(1),
        openTime      : data.readBigUInt64LE(2).toString(),
        initPcAmount  : data.readBigUInt64LE(10).toString(),
        initCoinAmount: data.readBigUInt64LE(18).toString(),
    };
}

async function fetchMarketAccountsFromChain(marketId) {
    try {
        const info = await connection.getAccountInfo(new PublicKey(marketId));
        if (!info || info.data.length < 341) return null;

        const d = info.data;
        return {
            marketEventQueue: new PublicKey(d.subarray(245, 277)).toString(),
            marketBids      : new PublicKey(d.subarray(277, 309)).toString(),
            marketAsks      : new PublicKey(d.subarray(309, 341)).toString(),
        };
    } catch (err) {
        console.error("Error fetching market account:", err.message);
        return null;
    }
}

// ──────────────────────────────────────────────────────────
// ———————————————  MAIN ENTRY  ———————————————
async function processRaydiumLpTransaction(connection, signature) {
    try {
        const tx = await connection.getTransaction(signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
        });
        if (!tx) { console.error("No transaction details found:", signature); return null; }

        const msg      = tx.transaction.message;
        const accounts = (msg.staticAccountKeys ?? msg.accountKeys).map(k => k.toString());
        const instrs   = msg.compiledInstructions || msg.instructions;
        if (!instrs) { console.error("No instructions found"); return null; }

        for (const ix of instrs) {
            const programId = accounts[ix.programIdIndex];
            if (programId !== RAYDIUM_AMM_PROGRAM_ID.toString() || ix.data.length === 0) continue;

            const accIdx = ix.accounts || ix.accountKeyIndexes;
            if (!accIdx) { console.error("No account indices"); continue; }

            const params         = parseCreateAmmLpParams(Buffer.from(ix.data, "base64"));
            const indexed        = {
                programId       : accounts[accIdx[0]],
                ammId           : accounts[accIdx[4]],
                ammAuthority    : accounts[accIdx[5]],
                ammOpenOrders   : accounts[accIdx[6]],
                lpMint          : accounts[accIdx[7]],
                baseMint        : accounts[accIdx[8]],
                quoteMint       : accounts[accIdx[9]],
                baseVault       : accounts[accIdx[10]],
                quoteVault      : accounts[accIdx[11]],
                ammTargetOrders : accounts[accIdx[13]],
                deployer        : accounts[accIdx[17]],
                marketProgramId : accounts[accIdx[15]],
                marketId        : accounts[accIdx[16]],
                marketBaseVault : accounts[accIdx[18]],
                marketQuoteVault: accounts[accIdx[19]],
                marketAuthority : accounts[accIdx[20]],
            };

            let tokenData = {
                programId         : RAYDIUM_AMM_PROGRAM_ID.toString(),
                ammId             : indexed.ammId,
                ammAuthority      : indexed.ammAuthority,
                ammOpenOrders     : indexed.ammOpenOrders,
                lpMint            : indexed.lpMint,
                baseMint          : indexed.baseMint,
                quoteMint         : indexed.quoteMint,
                baseVault         : indexed.baseVault,
                quoteVault        : indexed.quoteVault,
                ammTargetOrders   : indexed.ammTargetOrders,
                deployer          : indexed.deployer,
                marketProgramId   : indexed.marketProgramId,
                marketId          : indexed.marketId,
                marketBaseVault   : indexed.marketBaseVault,
                marketQuoteVault  : indexed.marketQuoteVault,
                marketAuthority   : indexed.marketAuthority,
                systemProgramId   : SYSTEM_PROGRAM_ID,
                tokenProgramId    : TOKEN_PROGRAM_ID_STR,
                associatedTokenProgramId: ASSOCIATED_TOKEN_PROGRAM_ID_STR,
                initPcAmount      : params.initPcAmount,
                initCoinAmount    : params.initCoinAmount,
                K                 : (BigInt(params.initPcAmount) * BigInt(params.initCoinAmount)).toString(),
                V                 : (
                    Math.min(Number(params.initPcAmount), Number(params.initCoinAmount)) /
                    Math.max(Number(params.initPcAmount), Number(params.initCoinAmount))
                ).toString(),
                isWSOLSwap        : indexed.baseMint === WSOL_MINT,
                wrappedSOLAmount  : indexed.baseMint === WSOL_MINT ? params.initCoinAmount : null,
                fee               : "0.003",
                token             : indexed.baseMint,
                baseDecimals      : 9,
                quoteDecimals     : 9,
                version           : "V2",
                marketVersion     : "V2",
                serumProgramId    : indexed.marketProgramId,
                serumMarket       : indexed.marketId,
                serumBids         : null,
                serumAsks         : null,
                serumEventQueue   : null,
            };

            // ── Pull Serum side‑accounts for full context ──
            const marketAccounts = await fetchMarketAccountsFromChain(tokenData.marketId);
            if (!marketAccounts) throw new Error("Missing critical market data for V2 swaps");

            tokenData = { ...tokenData, ...marketAccounts };

            console.log(
                "Full token data structure (sanitized):",
                JSON.stringify({ ...tokenData, tokenId: "REDACTED" }, null, 2)
            );

            // ── Persist & return – one hop, no extra processing ──
            const { insertedId } = await saveToMongo(tokenData);
            return { ...tokenData, tokenId: insertedId };  // ⭐ add tokenId & hand straight back
        }
    } catch (err) {
        if (err.message.includes("Cannot read properties of undefined (reading '_bn')")) {
            console.log("Skipping problematic transaction:", signature);
        } else {
            console.error("Processing error:", err.message);
        }
        return null;
    }
}

// ──────────────────────────────────────────────────────────
module.exports = {
    connectToDatabase,
    processRaydiumLpTransaction,
};
