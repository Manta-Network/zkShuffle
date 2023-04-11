import { assert, expect } from 'chai';
import { ethers } from 'hardhat';
import { resolve } from 'path';
import { convertPk, initDeck, keyGen, keyAggregate, sampleFieldElements, samplePermutation, searchDeck, compressDeck, recoverDeck, string2Bigint, prepareDecryptData } from '@poseidon-zkp/poseidon-zk-proof/src/shuffle/utilities';
import { shuffle, deal } from '@poseidon-zkp/poseidon-zk-proof/src/shuffle/proof'
import { DecryptVerifier } from 'types/@poseidon-zkp/poseidon-zk-circuits/contracts/decrypt_verifier.sol';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
const buildBabyjub = require('circomlibjs').buildBabyjub;

const fs = require('fs');
const https = require('https')
 
const HOME_DIR = require('os').homedir();
const P0X_DIR = resolve(HOME_DIR, "./.poseidon-zkp")
const P0X_AWS_URL = "https://p0x-labs.s3.amazonaws.com/refactor/"
async function dnld_aws(file_name : string) {
    fs.mkdir(P0X_DIR, () => {})
    fs.mkdir(resolve(P0X_DIR, './wasm'), () => {})
    fs.mkdir(resolve(P0X_DIR, './zkey'), () => {})
    return new Promise((reslv, reject) => {
        if (!fs.existsSync(resolve(P0X_DIR, file_name))) {
            const file = fs.createWriteStream(resolve(P0X_DIR, file_name))
            https.get(P0X_AWS_URL + file_name, (resp) => {
                file.on("finish", () => {
                    file.close();
                    reslv(0)
                });
                resp.pipe(file)
            });
        } else {
            reslv(0)
        }
    });
}

const resourceBasePath = P0X_DIR;

// Depploys contract for decryption.
async function deployDecrypt() {
    return <DecryptVerifier>await (await ethers.getContractFactory('DecryptVerifier')).deploy();
}

// Deploys contract for shuffle encrypt.
async function deployShuffleEncrypt() {
    const vk = await (await ethers.getContractFactory('ShuffleEncryptVerifierKey')).deploy();
    return await (await ethers.getContractFactory('Shuffle_encryptVerifier', {
        libraries: {
            ShuffleEncryptVerifierKey: vk.address,
        }
    })).deploy();
}

async function deployShuffleEncryptCARD30() {
    return await (await ethers.getContractFactory('Shuffle_encryptVerifier_30card')).deploy();
}

// Deploys contract for shuffle state machine.
async function deployStateMachine(shuffleStateMachineOwner: SignerWithAddress) {
    const shuffle_encrypt_verifier_contract = await deployShuffleEncrypt();
    const shuffleEncryptVerifier30CardContract = await deployShuffleEncryptCARD30();
    const decrypt_verifier_contract = await deployDecrypt();
    return await (await ethers.getContractFactory('Shuffle')).connect(shuffleStateMachineOwner).deploy(
        [
            {
                numCards : 52,
                encryptVerifier  : shuffle_encrypt_verifier_contract.address,
            },
            {
                numCards : 30,
                encryptVerifier  : shuffleEncryptVerifier30CardContract.address,
            }
        ],
        decrypt_verifier_contract.address
    );
}

describe('Shuffle test', function () {
    const NumCard2Deal = 5;
    const numPlayers = 2;
    beforeEach(async () => {
        await Promise.all(['wasm/decrypt.wasm', 'zkey/decrypt.zkey', 'wasm/shuffle_encrypt.wasm.52', 'zkey/shuffle_encrypt.zkey.52', 'wasm/shuffle_encrypt.wasm.30', 'zkey/shuffle_encrypt.zkey.30'].map(
            async (e) => {
                await dnld_aws(e)
            }
        ));
    });

    it('Shuffle state machine is correct', async () => {
        // Load metadata.
        const decryptWasmFile = resolve(resourceBasePath, './wasm/decrypt.wasm');
        const decryptZkeyFile = resolve(resourceBasePath, './zkey/decrypt.zkey');
        let gameId = 1; // Could be any positive number. 

        // Generates eth accounts
        let signers = await ethers.getSigners();
        let shuffleStateMachineOwner = signers[0];
        // Address of game contract. Note: a) only game contract can access shuffle state machine contract while players cannot;
        // b) To simplify the test code, we use this address to send data on behalf of players.
        let gameContract = signers[1];
        let playerAddrs = [];
        for (let i = 0; i < numPlayers; i++) {
            playerAddrs.push(signers[i + 2].address);
        }

        // Deploy Contracts
        const stateMachineContract = await deployStateMachine(shuffleStateMachineOwner);
        stateMachineContract.setGameContract(gameContract.address);

        const numBits = BigInt(251);
        const babyjub = await buildBabyjub();

        // Generates secret/public key for each player. Each player should run this line.
        // keys.pk: uint256 will be sent to smart contract.
        // keys.sk: uint256 will be kept secret by each player.
        const keys = [];
        let pkArray = [];
        const skArray = [];
        for (let i = 0; i < numPlayers; i++) {
            keys.push(keyGen(babyjub, numBits));
            pkArray.push(keys[i].pk);
            skArray.push(keys[i].sk);
        }
        pkArray = convertPk(babyjub, pkArray);

        const SHUFFLE_NUM_CARDS = [52, 30]
        for (const numCards of SHUFFLE_NUM_CARDS) {
            console.log("shuffle ", numCards, " cards!")
            stateMachineContract.connect(gameContract).setGameSettings(numPlayers, numCards, gameId);
            const shuffleEncryptWasmFile = resolve(resourceBasePath, './wasm/shuffle_encrypt.wasm.' + numCards);
            const shuffleEncryptZkeyFile = resolve(resourceBasePath, './zkey/shuffle_encrypt.zkey.' + numCards);

            // Registers three players
            for (let i = 0; i < numPlayers; i++) {
                await stateMachineContract.connect(gameContract).register(
                    playerAddrs[i],
                    [pkArray[i][0], pkArray[i][1]],
                    gameId
                );
            }

            // Queries aggregated public key
            const key = await stateMachineContract.queryAggregatedPk(gameId);
            const aggregatePk = [key[0].toBigInt(), key[1].toBigInt()];

            // Now shuffle the cards! Each player should run shuffleEncrypt.
            // Output is the shuffled card Y and a proof.
            for (let i = 0; i < numPlayers; i++) {
                let A = samplePermutation(Number(numCards));
                let R = sampleFieldElements(babyjub, numBits, BigInt(numCards));
                await shuffle(babyjub, A, R, aggregatePk, Number(numCards), gameId, playerAddrs[i], gameContract, stateMachineContract, shuffleEncryptWasmFile, shuffleEncryptZkeyFile);
                console.log('Player' + String(i) + ' shuffled the card!');
            }

            const initialDeck: bigint[] = initDeck(babyjub, Number(numCards));

            // Decrypts NumCard2Deal cards
            for (let i = 0; i < NumCard2Deal; i++) {
                let flag: boolean;
                let card: bigint[];
                for (let j = 0; j < numPlayers; j++) {
                    let curPlayerIdx = (Number(i) + j) % numPlayers;
                    if (j === 0) flag = true;
                    else flag = false;
                    card = await deal(
                        babyjub,
                        Number(numCards),
                        gameId,
                        i,
                        curPlayerIdx,
                        skArray[curPlayerIdx],
                        pkArray[curPlayerIdx],
                        playerAddrs[curPlayerIdx],
                        gameContract,
                        stateMachineContract,
                        decryptWasmFile,
                        decryptZkeyFile,
                        flag,
                    );
                    if (j === numPlayers - 1) {
                        const cardIdx = searchDeck(initialDeck, card[0], Number(numCards));
                        console.log('cardIdx: ', cardIdx);
                        expect(cardIdx).greaterThanOrEqual(0)
                    }
                }
            }
            console.log('Decrypt Done!!!');
            gameId++
        }
    })
});
