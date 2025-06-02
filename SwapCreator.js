/*****************************************************************
 swapCreator.js – BOT 9.35  (2025‑06‑02)
 *****************************************************************/
const {
    Connection, PublicKey, Keypair,
    ComputeBudgetProgram, SystemProgram,
    TransactionMessage, VersionedTransaction
} = require('@solana/web3.js');
const {
    getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction,
    createCloseAccountInstruction, getOrCreateAssociatedTokenAccount
} = require('@solana/spl-token');
const { MongoClient, ObjectId } = require('mongodb');
const bs58 = require('bs58');
require('dotenv').config();

/*───────────────────────────────────────────────────────────────
  0.  Version‑proof Raydium‑SDK loader
────────────────────────────────────────────────────────────────*/
let Liquidity, Token, TokenAmount, jsonInfo2PoolKeys;
async function loadRaydiumSdk() {
    if (Liquidity) return true;                       // memoise

    const mod = await import('@raydium-io/raydium-sdk-v2');

    if (mod.Liquidity) {                              // old CJS export
        ({ Liquidity, Token, TokenAmount, jsonInfo2PoolKeys } = mod);
    } else if (mod.default?.Liquidity) {              // ESM default export
        ({ Liquidity, Token, TokenAmount, jsonInfo2PoolKeys } = mod.default);
    } else if (mod.default?.liquidity) {              // new lowercase style
        Liquidity         = mod.default.liquidity;
        Token             = mod.default.token?.Token ?? mod.default.Token;
        TokenAmount       = mod.default.token?.TokenAmount ?? mod.default.TokenAmount;
        jsonInfo2PoolKeys = mod.default.liquidity.jsonInfo2PoolKeys
            ?? mod.default.jsonInfo2PoolKeys;
    }

    if (!sdk?.Liquidity)
        throw new Error(
            'Raydium SDK: could not locate Liquidity namespace – check @raydium-io/raydium-sdk-v2 version'
        );
}

/*───────────────────────────────────────────────────────────────
  1.  RPC connection
────────────────────────────────────────────────────────────────*/
const connection = new Connection(
    process.env.SOLANA_WS_URL || 'https://api.mainnet-beta.solana.com',
    { wsEndpoint: process.env.SOLANA_WS_URL || 'wss://api.mainnet-beta.solana.com',
        commitment: 'confirmed' }
);
const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

/*───────────────────────────────────────────────────────────────
  2.  Mongo helpers
────────────────────────────────────────────────────────────────*/
let db;
async function connectToDatabase() {
    if (db) return db;
    const cli = new MongoClient(process.env.MONGO_URI);
    await cli.connect();
    db = cli.db('bot');
    return db;
}
async function fetchTokenDataFromMongo(tokenId) {
    await connectToDatabase();
    const doc = await db.collection('raydium_lp_transactionsV3')
        .findOne({ _id: new ObjectId(tokenId) });
    if (!doc) throw new Error(`Token data not found for ID: ${tokenId}`);
    return doc;
}

/*───────────────────────────────────────────────────────────────
  3.  Build Raydium swap instruction
────────────────────────────────────────────────────────────────*/
async function createSwapInstruction(tokenData, userKeys, amountIn) {
    await loadRaydiumSdk();

    const poolKeys = jsonInfo2PoolKeys({
        id: tokenData.ammId,
        baseMint: tokenData.baseMint,
        quoteMint: tokenData.quoteMint,
        lpMint: tokenData.lpMint,
        baseDecimals: tokenData.baseDecimals,
        quoteDecimals: tokenData.quoteDecimals,
        programId: tokenData.programId ||
            '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
        authority: tokenData.ammAuthority,
        openOrders: tokenData.ammOpenOrders,
        targetOrders: tokenData.targetOrders,
        baseVault: tokenData.baseVault,
        quoteVault: tokenData.quoteVault,
        marketVersion: 4,
        marketProgramId: tokenData.marketProgramId,
        marketId: tokenData.marketId,
        marketBids: tokenData.marketBids,
        marketAsks: tokenData.marketAsks,
        marketEventQueue: tokenData.marketEventQueue,
        marketBaseVault: tokenData.marketBaseVault,
        marketQuoteVault: tokenData.marketQuoteVault,
        marketAuthority: tokenData.marketAuthority
    });

    const { innerTransactions } = await Liquidity.makeSwapInstructionSimple({
        connection,
        poolKeys,
        userKeys: {
            tokenAccountIn : new PublicKey(userKeys.tokenAccountIn),
            tokenAccountOut: new PublicKey(userKeys.tokenAccountOut),
            owner          : userKeys.owner
        },
        amountIn     : new TokenAmount(
            new Token(poolKeys.baseMint, poolKeys.baseDecimals),
            amountIn),
        amountOutMin : TokenAmount.zero,
        fixedSide    : 'in',
        makeTxVersion: 0
    });

    return innerTransactions[0].instructions;
}

/*───────────────────────────────────────────────────────────────
  4.  MAIN – swapTokens
────────────────────────────────────────────────────────────────*/
async function swapTokens({ lpData = null, tokenId = null,
                              amountSpecified, swapBaseIn }) {
    await loadRaydiumSdk();

    const owner = Keypair.fromSecretKey(bs58.default.decode(process.env.WALLET_PRIVATE_KEY));
    const tokenData = lpData ?? (await fetchTokenDataFromMongo(tokenId));

    const inputMint  = new PublicKey(swapBaseIn ? tokenData.baseMint  : tokenData.quoteMint);
    const outputMint = new PublicKey(swapBaseIn ? tokenData.quoteMint : tokenData.baseMint);

    const [tokenIn, tokenOut] = await Promise.all([
        getOrCreateAssociatedTokenAccount(connection, owner, inputMint , owner.publicKey).then(r => r.address),
        getOrCreateAssociatedTokenAccount(connection, owner, outputMint, owner.publicKey).then(r => r.address)
    ]);

    const pre  = [];
    const post = [];
    if (inputMint.equals(WSOL_MINT)) {
        pre.push(
            SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: tokenIn,
                lamports: amountSpecified }),
            createAssociatedTokenAccountInstruction(
                owner.publicKey, tokenIn, owner.publicKey, WSOL_MINT
            )
        );
        post.push(createCloseAccountInstruction(tokenIn, owner.publicKey, owner.publicKey));
    }

    const swapIx = await createSwapInstruction(
        tokenData,
        { tokenAccountIn: tokenIn.toString(),
            tokenAccountOut: tokenOut.toString(),
            owner: owner.publicKey },
        amountSpecified
    );

    const { blockhash } = await connection.getLatestBlockhash();
    const tx = new VersionedTransaction(
        new TransactionMessage({
            payerKey: owner.publicKey,
            recentBlockhash: blockhash,
            instructions: [
                ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
                ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
                ...pre, ...swapIx, ...post
            ]
        }).compileToV0Message()
    );
    tx.sign([owner]);

    const sig  = await connection.sendTransaction(tx);
    const conf = await connection.confirmTransaction(sig, 'confirmed');

    await connectToDatabase();
    await db.collection('swapAttempts').insertOne({
        tokenId: tokenId ?? tokenData.tokenId ?? null,
        amount: amountSpecified,
        direction: swapBaseIn ? 'sell' : 'buy',
        signature: sig,
        timestamp: new Date(),
        status: conf.value.err ? 'failed' : 'success'
    });

    return sig;
}

/*───────────────────────────────────────────────────────────────
  5.  Helper – price logger
────────────────────────────────────────────────────────────────*/
async function calculatePriceFromPool(tokenData) {
    await loadRaydiumSdk();
    const poolKeys = jsonInfo2PoolKeys({
        /* same mapping as above */ ...tokenData
    });
    const state = await Liquidity.fetchState({ connection, poolKeys });
    return state.quoteReserve.toNumber() / state.baseReserve.toNumber();
}

/*───────────────────────────────────────────────────────────────*/
module.exports = {
    swapTokens,
    connectToDatabase,
    fetchTokenDataFromMongo
};
