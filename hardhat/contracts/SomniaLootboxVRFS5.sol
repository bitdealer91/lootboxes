// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SomniaLootboxVRF} from "./SomniaLootboxVRF.sol";

/// @notice Season 5 Somnia lootbox: VRF flow with a hard cap of 2 successful opens (on-chain guard in addition to mixer key limits).
contract SomniaLootboxVRFS5 is SomniaLootboxVRF {
    constructor(address keys_, address vrfWrapper_, uint32 callbackGasLimit_, uint16 requestConfirmations_)
        SomniaLootboxVRF(keys_, vrfWrapper_, callbackGasLimit_, requestConfirmations_, 2)
    {}
}
