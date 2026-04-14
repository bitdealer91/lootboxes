// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVRFV2PlusWrapper} from "@chainlink/contracts/src/v0.8/vrf/dev/interfaces/IVRFV2PlusWrapper.sol";

interface IRawVrfConsumer {
    function rawFulfillRandomWords(uint256 requestId, uint256[] memory randomWords) external;
}

/// @notice Minimal mock VRF v2+ wrapper for unit tests (native payment path).
contract MockVRFV2PlusWrapper is IVRFV2PlusWrapper {
    uint256 private _lastRequestId;
    uint256 public nativePriceWei;
    address private immutable linkAddr;

    constructor(address link_, uint256 nativePriceWei_) {
        linkAddr = link_;
        nativePriceWei = nativePriceWei_;
    }

    function setNativePriceWei(uint256 v) external {
        nativePriceWei = v;
    }

    function lastRequestId() external view override returns (uint256) {
        return _lastRequestId;
    }

    function link() external view override returns (address) {
        return linkAddr;
    }

    function linkNativeFeed() external view override returns (address) {
        return address(0);
    }

    function calculateRequestPrice(uint32, uint32) external view override returns (uint256) {
        return nativePriceWei;
    }

    function calculateRequestPriceNative(uint32, uint32) external view override returns (uint256) {
        return nativePriceWei;
    }

    function estimateRequestPrice(uint32, uint32, uint256) external view override returns (uint256) {
        return nativePriceWei;
    }

    function estimateRequestPriceNative(uint32, uint32, uint256) external view override returns (uint256) {
        return nativePriceWei;
    }

    function requestRandomWordsInNative(
        uint32,
        uint16,
        uint32,
        bytes calldata
    ) external payable override returns (uint256 requestId) {
        require(msg.value >= nativePriceWei, "MOCK_VRF_PAY");
        _lastRequestId += 1;
        return _lastRequestId;
    }

    /// @dev Test helper: simulate oracle fulfillment (`msg.sender` seen by consumer is this wrapper).
    function fulfill(address consumer, uint256 requestId, uint256[] calldata randomWords) external {
        IRawVrfConsumer(consumer).rawFulfillRandomWords(requestId, randomWords);
    }
}
