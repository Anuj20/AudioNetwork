// Copyright (c) 2015-2017 Robert Rypuła - https://audio-network.rypula.pl
'use strict';

var
    BASE_TIME_MS = 200,   // 500 or 166
    SAMPLE_PER_SYBMOL = 3,
    FFT_SIZE = 4 * 1024,
    FFT_FREQUENCY_BIN_SKIP_FACTOR = 5,

    SYMBOL_MIN = 93,
    SYMBOL_MAX = 117,
    SYMBOL_SYNC_A = 108,
    SYMBOL_SYNC_B = 109,

    TX_SAMPLE_RATE = 48000,
    TX_AMPLITUDE = 0.1,

    audioMonoIO,

    connectionDetail = null,
    connectInProgress,
    correlator,
    rxSignalThresholdDecibel,
    rxSamplingBlock = [],
    rxSymbolList = [],

    rxSpectrogram,
    rxSampleNumber = 0,
    rxSmartTimer,
    txSmartTimer,
    txSampleRate,
    txSampleNumber = 0,
    txCurrentSymbol = null,
    txSymbolQueue = [];

function init() {
    audioMonoIO = new AudioMonoIO(FFT_SIZE);
    correlator = new Correlator(SAMPLE_PER_SYBMOL);
    document.getElementById('rx-sample-rate').innerHTML = audioMonoIO.getSampleRate();

    initFloatWidget();

    rxSpectrogram = new Spectrogram(document.getElementById('rx-spectrogram'));
    rxSmartTimer = new SmartTimer(BASE_TIME_MS / 1000);
    rxSmartTimer.setHandler(rxSmartTimerHandler);

    setTimeout(function () {
        txSmartTimer = new SmartTimer(BASE_TIME_MS / 1000);
        txSmartTimer.setHandler(txSmartTimerHandler);
    }, 250);

    onLoopbackCheckboxChange();

    document.addEventListener('keyup', function(e) {
        var digit = null;

        if (e.keyCode >= 48 && e.keyCode <= 57) {
            digit = e.keyCode - 48;
        } else {
            if (e.keyCode >= 96 && e.keyCode <= 105) {
                digit = e.keyCode - 96;
            }
        }

        if (digit !== null) {
            txSymbol(100 + digit);
        }
    }, true);
}

function onLoopbackCheckboxChange() {
    if (audioMonoIO) {
        audioMonoIO.setLoopback(document.getElementById('loopback-checkbox').checked);
    }
}

function initFloatWidget() {
    txSampleRate = new EditableFloatWidget(
        document.getElementById('tx-sample-rate'),
        TX_SAMPLE_RATE, 5, 0,
        null
    );
}

function setTxSound(symbol, edge) {
    var frequency;

    if (!symbol) {
        audioMonoIO.setPeriodicWave(undefined, 0);
        return;
    }

    frequency = FFT_FREQUENCY_BIN_SKIP_FACTOR * symbol * txSampleRate.getValue() / FFT_SIZE;
    audioMonoIO.setPeriodicWave(
        frequency,
        (edge ? 0.1 : 1) * TX_AMPLITUDE
    );
}

function refreshTxSymbolQueue() {
    html('#tx-symbol-queue', txSymbolQueue.join(', '));
}

function refreshRxSymbolList() {
    html('#rx-symbol-list', rxSymbolList.join(', '));
}

// ----------------------

function addToTxQueue(symbol) {
    txSymbolQueue.push(symbol);
}

function txConnect(sampleRate) {
    var i, codeValue;

    txSampleRate.setValue(sampleRate);
    for (i = 0; i < correlator.getCodeLength(); i++) {
        codeValue = correlator.getCodeValue(i);
        addToTxQueue(
            codeValue === -1 ? SYMBOL_SYNC_A : SYMBOL_SYNC_B
        );
    }
    refreshTxSymbolQueue();
}

function txSymbol(symbol) {
    addToTxQueue(symbol);
    refreshTxSymbolQueue();
}

// ----------------------

function sortConnectionDetail(data) {
    data.sort(function (a, b) {
        return 0 ||
            a.correlationValue < b.correlationValue ? 1 : a.correlationValue > b.correlationValue ? -1 : 0 ||
            a.signalDecibel < b.signalDecibel ? 1 : a.signalDecibel > b.signalDecibel ? -1 : 0;
    });
}

function findStrongestConnectionDetail() {
    var offset, decisionList, innerDecisionList;

    // console.log(rxSamplingBlock.slice(0));
    decisionList = [];
    for (offset = 0; offset < SAMPLE_PER_SYBMOL; offset++) {
        innerDecisionList = rxSamplingBlock[offset].decisionList;
        if (innerDecisionList.length > 0) {
            sortConnectionDetail(innerDecisionList);
            decisionList.push(innerDecisionList[0]);
        }
    }
    
    sortConnectionDetail(decisionList);

    connectionDetail = decisionList[0];

}

function tryToDetectConnectSignal(rxSampleNumber, symbolRaw, signalDecibel, noiseDecibel) {
    var dataLogicValue, offset, connectSignalDetected, lastConnectSignalDetected, isLastOffsetInSamplingBlock;

    offset = rxSampleNumber % SAMPLE_PER_SYBMOL;
    isLastOffsetInSamplingBlock = offset === (SAMPLE_PER_SYBMOL - 1);

    switch (symbolRaw) {
        case SYMBOL_SYNC_A: dataLogicValue = false; break;
        case SYMBOL_SYNC_B: dataLogicValue = true; break;
        default: dataLogicValue = null;
    }
    correlator.handle(dataLogicValue, signalDecibel, noiseDecibel);
    connectSignalDetected = correlator.isCorrelatedHigh();

    if (!rxSamplingBlock[offset]) {
        rxSamplingBlock[offset] = {
            decisionList: [],
            connectSignalJustLost: undefined,
            connectSignalDetected: undefined
        };
    }

    if (connectSignalDetected) {
        rxSamplingBlock[offset].decisionList.push({
            offset: offset,
            correlationValue: Math.abs(correlator.getCorrelationValue()),
            signalDecibel: correlator.getSignalDecibelAverage(),
            noiseDecibel: correlator.getNoiseDecibelAverage(),
            signalToNoiseRatio: correlator.getSignalToNoiseRatio()
        });
    }
    lastConnectSignalDetected = rxSamplingBlock[offset].connectSignalDetected;
    rxSamplingBlock[offset].connectSignalJustLost = lastConnectSignalDetected === true && !connectSignalDetected;
    rxSamplingBlock[offset].connectSignalDetected = connectSignalDetected;

    if (isLastOffsetInSamplingBlock) {
        for (offset = 0; offset < rxSamplingBlock.length; offset++) {
            if (rxSamplingBlock[offset].connectSignalJustLost === true) {
                findStrongestConnectionDetail();
                rxSignalThresholdDecibel = connectionDetail.noiseDecibel + 0.3 * connectionDetail.signalToNoiseRatio;
                rxSamplingBlock.length = 0;        // TODO bad reset, refactor
                correlator.reset();
                break;
            }
        }
    }

    connectInProgress = false;
    for (offset = 0; offset < rxSamplingBlock.length; offset++) {
        if (rxSamplingBlock[offset].connectSignalDetected === true || rxSamplingBlock[offset].connectSignalJustLost === true) {
            connectInProgress = true;
            break;
        }
    }

    if (connectInProgress) {
        html('#rx-log-connect', 'connecting...');
    } else {
        if (connectionDetail) {
            html(
                '#rx-log-connect',
                'Connected!<br/>' +
                '- offset ' + connectionDetail.offset + '<br/>' +
                '- SNR ' + connectionDetail.signalToNoiseRatio.toFixed(2) + ' dB' + '<br/>' +
                '- correlation ' + connectionDetail.correlationValue + '/' + correlator.getCodeLength() + '<br/>' +
                '- threshold ' + rxSignalThresholdDecibel.toFixed() + 'dB'
                // offset: 2, correlationValue: 18, signalDecibel: -53.55561235215929, noiseDecibel: -219.78040854136145, signalToNoiseRatio: 166.22479618920215}
            );
            //console.log(connectionDetail);
        } else {
            html('#rx-log-connect', 'not connected');
        }
    }
}

// ----------------------

function rxSmartTimerHandler() {
    var
        offset = rxSampleNumber % SAMPLE_PER_SYBMOL,
        frequencyData,
        fftResult,
        symbol,
        signalDecibel,
        signalQualityDecibel,
        noiseDecibelSum,
        noiseDecibel,
        isSymbolSamplingPoint,
        isSynchronizedSymbol,
        frequencyDataInner = [],
        i;

    frequencyData = audioMonoIO.getFrequencyData();
    fftResult = new FFTResult(frequencyData, audioMonoIO.getSampleRate());
    fftResult.downconvertScalar(FFT_FREQUENCY_BIN_SKIP_FACTOR);
    symbol = fftResult.getLoudestBinIndexInBinRange(SYMBOL_MIN, SYMBOL_MAX);
    signalDecibel = fftResult.getDecibel(symbol);

    noiseDecibelSum = 0;
    for (i = SYMBOL_MIN; i <= SYMBOL_MAX; i++) {
        frequencyDataInner.push(fftResult.getDecibel(i));
        if (i !== symbol) {
            noiseDecibelSum += fftResult.getDecibel(i);
        }
    }
    noiseDecibel = null;
    if (frequencyDataInner.length > 1) {
        noiseDecibel = noiseDecibelSum / (frequencyDataInner.length - 1);
    }

    tryToDetectConnectSignal(rxSampleNumber, symbol, signalDecibel, noiseDecibel);

    isSymbolSamplingPoint = connectionDetail
        ? rxSampleNumber % SAMPLE_PER_SYBMOL === connectionDetail.offset
        : false;
    isSynchronizedSymbol = isSymbolSamplingPoint && (signalDecibel > rxSignalThresholdDecibel);

    //console.log(isSynchronizedSymbol);

    if (document.getElementById('rx-active').checked) {
        rxSpectrogram.add(
            frequencyDataInner,
            document.getElementById('loudest-marker').checked ? symbol - SYMBOL_MIN : -1,
            SYMBOL_MIN,
            1,
            isSynchronizedSymbol
        );
    }

    if (connectionDetail) {
        if (isSymbolSamplingPoint) {
            if (isSynchronizedSymbol) {
                signalQualityDecibel = Math.round(signalDecibel - rxSignalThresholdDecibel);
                html('#rx-symbol-synchronized', symbol + ' (' + signalQualityDecibel + ' dB)');
                // html('#rx-symbol-synchronized-detail', signalQualityDecibel);
                rxSymbolList.push(symbol);

                //console.log(rxSampleNumber, offset, symbol);
                refreshRxSymbolList();
            } else {
                html('#rx-symbol-synchronized', 'idle');
                html('#rx-symbol-synchronized-detail', '');
            }
        }
    } else {
        html('#rx-symbol-synchronized', '');
    }

    html('#rx-symbol', symbol);
    html(
        '#rx-symbol-detail',
        offset + '/' + rxSampleNumber + ', ' +
        fftResult.getFrequency(symbol).toFixed(2) + ' Hz, ' +
        signalDecibel.toFixed(2) + ' dB'
    );
    html(
        '#rx-log',
        'min: ' + SYMBOL_MIN + ' (' + fftResult.getFrequency(SYMBOL_MIN).toFixed(2) + ' Hz)<br/>' +
        'max: ' + SYMBOL_MAX + ' (' + fftResult.getFrequency(SYMBOL_MAX).toFixed(2) + ' Hz)<br/>' +
        'range: ' + (SYMBOL_MAX - SYMBOL_MIN + 1) + '<br/>'
    );

    rxSampleNumber++;
}

function txSmartTimerHandler() {
    var
        offset = txSampleNumber % SAMPLE_PER_SYBMOL,
        edge;

    if (offset === 0) {
        txCurrentSymbol = txSymbolQueue.shift();
    }

    if (SAMPLE_PER_SYBMOL > 2) {
        edge = (offset === 0) || (offset === (SAMPLE_PER_SYBMOL - 1));
    } else {
        edge = false;
    }

    setTxSound(txCurrentSymbol, edge);
    refreshTxSymbolQueue();

    txSampleNumber++;
}
