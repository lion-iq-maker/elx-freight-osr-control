module.exports = async function (context, req) {
    const endpoint = process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT;
    const key = process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY;

    if (!endpoint || !key) {
        context.res = {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                error: 'Missing Azure AI Document Intelligence credentials'
            })
        };
        return;
    }

    const body = req.body || {};
    const imageBase64 = body.image;

    if (!imageBase64) {
        context.res = {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                error: 'No image provided. Send {"image":"base64string"}'
            })
        };
        return;
    }

    try {
        // ------------------------------------------------------------
        // 1. Convert image from Base64
        // ------------------------------------------------------------
        const cleanBase64 = imageBase64.includes(',')
            ? imageBase64.split(',').pop()
            : imageBase64;

        const imageBuffer = Buffer.from(cleanBase64, 'base64');

        // ------------------------------------------------------------
        // 2. Send image to Azure Document Intelligence
        // ------------------------------------------------------------
        const modelId = 'prebuilt-document';
        const apiVersion = '2023-07-31';

        const cleanEndpoint = endpoint.replace(/\/+$/, '');

        const analyzeUrl =
            `${cleanEndpoint}/formrecognizer/documentModels/` +
            `${modelId}:analyze?api-version=${apiVersion}`;

        const response = await fetch(analyzeUrl, {
            method: 'POST',
            headers: {
                'Ocp-Apim-Subscription-Key': key,
                'Content-Type': 'application/octet-stream'
            },
            body: imageBuffer
        });

        if (!response.ok) {
            const errorText = await response.text();

            throw new Error(
                `Azure Document Intelligence error: ` +
                `${response.status} - ${errorText}`
            );
        }

        const operationLocation =
            response.headers.get('operation-location');

        if (!operationLocation) {
            throw new Error(
                'Azure did not return an operation-location header.'
            );
        }

        // ------------------------------------------------------------
        // 3. Poll Azure until analysis completes
        // ------------------------------------------------------------
        let analyzeResult = null;
        const maxAttempts = 30;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const pollResponse = await fetch(operationLocation, {
                headers: {
                    'Ocp-Apim-Subscription-Key': key
                }
            });

            if (!pollResponse.ok) {
                const pollError = await pollResponse.text();

                throw new Error(
                    `Azure polling error: ` +
                    `${pollResponse.status} - ${pollError}`
                );
            }

            const pollData = await pollResponse.json();

            if (pollData.status === 'succeeded') {
                analyzeResult = pollData.analyzeResult;
                break;
            }

            if (pollData.status === 'failed') {
                throw new Error(
                    pollData.error?.message ||
                    'Azure document analysis failed.'
                );
            }

            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        if (!analyzeResult) {
            throw new Error(
                'Document analysis timed out after 30 seconds.'
            );
        }

        // ============================================================
        // 4. ELX FREIGHT FIELD DEFINITIONS
        // ============================================================
        const fieldDefinitions = {
            supplier: [
                'supplier',
                'supplier sender',
                'supplier / sender',
                'sender',
                'vendor',
                'shipper'
            ],

            site: [
                'delivery site',
                'delivery destination',
                'destination',
                'deliver to',
                'ship to'
            ],

            contractor: [
                'bhp contractor name',
                'bhp contractor',
                'contractor name'
            ],

            po: [
                'po number',
                'po no',
                'po #',
                'p/o number',
                'purchase order',
                'purchase order number'
            ],

            reference: [
                'other reference',
                'other references',
                'reference number',
                'reference no',
                'reference',
                'ref number',
                'ref no'
            ],

            connote: [
                'connote / consignment',
                'connote',
                'consignment number',
                'consignment no',
                'consignment',
                'tracking number',
                'waybill'
            ],

            itemType: [
                'item type',
                'freight type',
                'freight description',
                'item description'
            ],

            qty: [
                'quantity',
                'qty',
                'pieces',
                'piece count'
            ],

            weight: [
                'weight kg',
                'weight (kg)',
                'gross weight',
                'gross weight kg',
                'total weight'
            ]
        };

        // ============================================================
        // 5. NORMALISATION HELPERS
        // ============================================================
        function normalizeLabel(value) {
            if (!value) {
                return '';
            }

            return String(value)
                .toLowerCase()
                .replace(/[*:#()[\]{}]/g, ' ')
                .replace(/\//g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
        }

        function cleanValue(value) {
            if (value === null || value === undefined) {
                return '';
            }

            let result = String(value).trim();

            // Remove only leading/trailing separator noise.
            // Do NOT remove internal hyphens/slashes.
            result = result.replace(/^[\s:|=*]+/, '');
            result = result.replace(/[\s:*]+$/, '');
            result = result.replace(/\s+/g, ' ');

            return result.trim();
        }

        function isValidValue(field, value) {
            const cleaned = cleanValue(value);

            if (!cleaned) {
                return false;
            }

            // Prevent labels from becoming values
            const normalizedValue = normalizeLabel(cleaned);
            const allKnownLabels = Object.values(fieldDefinitions).flat();

            for (const knownLabel of allKnownLabels) {
                const normalizedKnown = normalizeLabel(knownLabel);

                if (normalizedValue === normalizedKnown) {
                    return false;
                }
            }

            if (field === 'qty') {
                return /^\d{1,6}$/.test(
                    cleaned.replace(/,/g, '')
                );
            }

            if (field === 'weight') {
                return /^\d[\d,.]*(\s*kg)?$/i.test(cleaned);
            }

            if (field === 'po') {
                return cleaned.length >= 3;
            }

            if (
                field === 'supplier' ||
                field === 'site' ||
                field === 'contractor' ||
                field === 'reference' ||
                field === 'connote' ||
                field === 'itemType'
            ) {
                return cleaned.length >= 2;
            }

            return true;
        }

        function labelsMatch(actualLabel, aliases) {
            const actual = normalizeLabel(actualLabel);

            if (!actual) {
                return false;
            }

            return aliases.some(alias => {
                const expected = normalizeLabel(alias);

                if (actual === expected) {
                    return true;
                }

                if (
                    expected.length >= 5 &&
                    actual.startsWith(expected + ' ')
                ) {
                    return true;
                }

                return false;
            });
        }

        function escapeRegExp(value) {
            return String(value).replace(
                /[.*+?^${}()|[\]\\]/g,
                '\\$&'
            );
        }

        // ============================================================
        // 6. RESULT OBJECT
        // ============================================================
        const extracted = {
            supplier: '',
            site: '',
            contractor: '',
            po: '',
            reference: '',
            connote: '',
            itemType: '',
            qty: '',
            weight: ''
        };

        const extractionSource = {
            supplier: '',
            site: '',
            contractor: '',
            po: '',
            reference: '',
            connote: '',
            itemType: '',
            qty: '',
            weight: ''
        };

        // Raw OCR text is useful for diagnostics and fallback parsing.
        const rawText = analyzeResult.content || '';

        // ============================================================
        // 7. STRATEGY ONE: AZURE KEY / VALUE PAIRS
        // ============================================================
        const keyValuePairs =
            analyzeResult.keyValuePairs || [];

        for (const pair of keyValuePairs) {
            const keyText =
                pair.key?.content || '';

            const valueText =
                pair.value?.content || '';

            if (!keyText || !valueText) {
                continue;
            }

            for (
                const [field, aliases]
                of Object.entries(fieldDefinitions)
            ) {
                if (extracted[field]) {
                    continue;
                }

                if (labelsMatch(keyText, aliases)) {
                    const cleaned = cleanValue(valueText);

                    if (isValidValue(field, cleaned)) {
                        extracted[field] = cleaned;
                        extractionSource[field] = 'azure-key-value';
                    }
                }
            }
        }

        // ============================================================
        // 8. GET OCR LINES
        // ============================================================
        const pages =
            analyzeResult.pages || [];

        const lines = [];

        for (const page of pages) {
            for (const line of page.lines || []) {
                const content =
                    cleanValue(line.content);

                if (!content) {
                    continue;
                }

                lines.push({
                    text: content,
                    polygon: line.polygon || [],
                    pageNumber:
                        page.pageNumber || 1
                });
            }
        }

        // ============================================================
        // 9. SAME-LINE FALLBACK
        // ============================================================
        function extractSameLineValue(
            lineText,
            aliases
        ) {
            const original =
                String(lineText).trim();

            const normalizedOriginal =
                normalizeLabel(original);

            const sortedAliases =
                [...aliases].sort(
                    (a, b) =>
                        b.length - a.length
                );

            for (const alias of sortedAliases) {
                const normalizedAlias =
                    normalizeLabel(alias);

                if (
                    !normalizedOriginal.startsWith(
                        normalizedAlias
                    )
                ) {
                    continue;
                }

                const patterns = [
                    new RegExp(
                        '^\\s*' +
                        escapeRegExp(alias) +
                        '\\s*[:|=]\\s*(.+)$',
                        'i'
                    ),

                    new RegExp(
                        '^\\s*' +
                        escapeRegExp(alias) +
                        '\\s+(.+)$',
                        'i'
                    )
                ];

                for (const pattern of patterns) {
                    const match =
                        original.match(pattern);

                    if (
                        match &&
                        match[1]
                    ) {
                        const candidate =
                            cleanValue(match[1]);

                        if (candidate) {
                            return candidate;
                        }
                    }
                }
            }

            return '';
        }

        for (const line of lines) {
            for (
                const [field, aliases]
                of Object.entries(fieldDefinitions)
            ) {
                if (extracted[field]) {
                    continue;
                }

                const candidate =
                    extractSameLineValue(
                        line.text,
                        aliases
                    );

                if (
                    candidate &&
                    isValidValue(
                        field,
                        candidate
                    )
                ) {
                    extracted[field] =
                        candidate;

                    extractionSource[field] =
                        'same-line';
                }
            }
        }

        // ============================================================
        // 10. GEOMETRY FALLBACK
        // ============================================================
        function boundingBox(polygon) {
            if (
                !polygon ||
                polygon.length < 4
            ) {
                return null;
            }

            const xs = [];
            const ys = [];

            if (
                typeof polygon[0] === 'number'
            ) {
                for (
                    let i = 0;
                    i < polygon.length;
                    i += 2
                ) {
                    xs.push(polygon[i]);

                    if (
                        polygon[i + 1] !== undefined
                    ) {
                        ys.push(
                            polygon[i + 1]
                        );
                    }
                }
            } else {
                for (const point of polygon) {
                    if (
                        point.x !== undefined &&
                        point.y !== undefined
                    ) {
                        xs.push(point.x);
                        ys.push(point.y);
                    }
                }
            }

            if (!xs.length || !ys.length) {
                return null;
            }

            return {
                left: Math.min(...xs),
                right: Math.max(...xs),
                top: Math.min(...ys),
                bottom: Math.max(...ys),

                centerX:
                    (
                        Math.min(...xs) +
                        Math.max(...xs)
                    ) / 2,

                centerY:
                    (
                        Math.min(...ys) +
                        Math.max(...ys)
                    ) / 2
            };
        }

        function looksLikeAnyLabel(text) {
            const normalized =
                normalizeLabel(text);

            if (!normalized) {
                return false;
            }

            return Object.values(
                fieldDefinitions
            )
                .flat()
                .some(alias => {
                    const expected =
                        normalizeLabel(alias);

                    return (
                        normalized === expected ||
                        normalized.startsWith(
                            expected + ' '
                        )
                    );
                });
        }

        function findValueBelowLabel(
            labelLine,
            field
        ) {
            const labelBox =
                boundingBox(
                    labelLine.polygon
                );

            if (!labelBox) {
                return '';
            }

            const candidates = [];

            for (const candidate of lines) {
                if (candidate === labelLine) {
                    continue;
                }

                if (
                    candidate.pageNumber !==
                    labelLine.pageNumber
                ) {
                    continue;
                }

                if (
                    looksLikeAnyLabel(
                        candidate.text
                    )
                ) {
                    continue;
                }

                const candidateBox =
                    boundingBox(
                        candidate.polygon
                    );

                if (!candidateBox) {
                    continue;
                }

                const verticalGap =
                    candidateBox.top -
                    labelBox.bottom;

                if (
                    verticalGap < -0.02 ||
                    verticalGap > 1.50
                ) {
                    continue;
                }

                const overlapLeft =
                    Math.max(
                        labelBox.left,
                        candidateBox.left
                    );

                const overlapRight =
                    Math.min(
                        labelBox.right,
                        candidateBox.right
                    );

                const overlap =
                    Math.max(
                        0,
                        overlapRight -
                        overlapLeft
                    );

                const labelWidth =
                    Math.max(
                        0.01,
                        labelBox.right -
                        labelBox.left
                    );

                const candidateWidth =
                    Math.max(
                        0.01,
                        candidateBox.right -
                        candidateBox.left
                    );

                const overlapRatio =
                    overlap /
                    Math.min(
                        labelWidth,
                        candidateWidth
                    );

                const horizontalDistance =
                    Math.abs(
                        candidateBox.centerX -
                        labelBox.centerX
                    );

                if (
                    overlapRatio < 0.15 &&
                    horizontalDistance > 1.2
                ) {
                    continue;
                }

                const value =
                    cleanValue(
                        candidate.text
                    );

                if (
                    !isValidValue(
                        field,
                        value
                    )
                ) {
                    continue;
                }

                const score =
                    Math.max(
                        verticalGap,
                        0
                    ) +
                    horizontalDistance * 0.25;

                candidates.push({
                    value,
                    score
                });
            }

            candidates.sort(
                (a, b) =>
                    a.score - b.score
            );

            return candidates[0]?.value || '';
        }

        for (
            const [field, aliases]
            of Object.entries(fieldDefinitions)
        ) {
            if (extracted[field]) {
                continue;
            }

            for (const line of lines) {
                if (
                    !labelsMatch(
                        line.text,
                        aliases
                    )
                ) {
                    continue;
                }

                const candidate =
                    findValueBelowLabel(
                        line,
                        field
                    );

                if (
                    candidate &&
                    isValidValue(
                        field,
                        candidate
                    )
                ) {
                    extracted[field] =
                        candidate;

                    extractionSource[field] =
                        'geometry-below-label';

                    break;
                }
            }
        }

        // ============================================================
        // 11. FREIGHT ITEMS ROW FALLBACK
        //
        // Azure raw OCR example:
        //
        // Item Type Quantity Weight (kg) Stillage 3 410
        //
        // If Azure sees the table but does not return key/value pairs,
        // parse this known freight row conservatively.
        // ============================================================
        if (
            !extracted.itemType ||
            !extracted.qty ||
            !extracted.weight
        ) {
            const normalizedRaw =
                rawText
                    .replace(/\s+/g, ' ')
                    .trim();

            const freightMatch =
                normalizedRaw.match(
                    /item\s*type\s+quantity\s+weight\s*\(?kg\)?\s+([a-z][a-z\s-]*?)\s+(\d+)\s+(\d+(?:\.\d+)?)(?=\s|$)/i
                );

            if (freightMatch) {
                const detectedItemType =
                    freightMatch[1].trim();

                const detectedQty =
                    freightMatch[2].trim();

                const detectedWeight =
                    freightMatch[3].trim();

                const allowedItemTypes = [
                    'Carton',
                    'Satchel',
                    'Pallet',
                    'Crate',
                    'Basket',
                    'Parcel',
                    'Stillage',
                    'IBC',
                    'Loose Freight',
                    'Other'
                ];

                const matchedItemType =
                    allowedItemTypes.find(
                        type =>
                            type.toLowerCase() ===
                            detectedItemType.toLowerCase()
                    );

                if (
                    !extracted.itemType &&
                    matchedItemType
                ) {
                    extracted.itemType =
                        matchedItemType;

                    extractionSource.itemType =
                        'freight-row-fallback';
                }

                if (
                    !extracted.qty &&
                    /^\d+$/.test(detectedQty)
                ) {
                    extracted.qty =
                        detectedQty;

                    extractionSource.qty =
                        'freight-row-fallback';
                }

                if (
                    !extracted.weight &&
                    /^\d+(?:\.\d+)?$/.test(
                        detectedWeight
                    )
                ) {
                    extracted.weight =
                        detectedWeight;

                    extractionSource.weight =
                        'freight-row-fallback';
                }
            }
        }

        // ============================================================
        // 12. FINAL FIELD CLEAN-UP
        // ============================================================

        if (extracted.weight) {
            extracted.weight =
                extracted.weight
                    .replace(/\s*kg$/i, '')
                    .trim();
        }

        if (extracted.qty) {
            extracted.qty =
                extracted.qty
                    .replace(/,/g, '')
                    .trim();
        }

        // Fix OCR spacing around hyphens
        //
        // REF-CARR- 1182 -> REF-CARR-1182
        // RXL - 660421   -> RXL-660421

        for (const field of ['reference', 'connote']) {
            if (extracted[field]) {
                extracted[field] =
                    extracted[field]
                        .replace(/\s*-\s*/g, '-')
                        .trim();
            }
        }

        // ============================================================
        // 13. IMPORTANT ELX BUSINESS RULE
        //
        // NEVER GUESS.
        //
        // If OCR cannot confidently identify a field,
        // leave it blank so the warehouse user can review/fill it.
        // ============================================================

        context.log(
            'ELX OCR extraction:',
            extracted
        );

        context.log(
            'ELX OCR extraction source:',
            extractionSource
        );

        // ============================================================
        // 14. RETURN RESULT TO FRONT END
        // ============================================================

        context.res = {
            status: 200,
            headers: {
                'Content-Type':
                    'application/json'
            },
            body: JSON.stringify({
                success: true,
                extracted,
                extractionSource,
                rawText
            })
        };

    } catch (error) {
        context.log.error(
            'OCR error:',
            error
        );

        context.res = {
            status: 500,
            headers: {
                'Content-Type':
                    'application/json'
            },
            body: JSON.stringify({
                success: false,
                error:
                    error.message ||
                    'Unknown OCR error'
            })
        };
    }
};
