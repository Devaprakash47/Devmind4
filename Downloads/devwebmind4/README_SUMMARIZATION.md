# Transformer-Based Abstractive Summarization (No External Model)

## Features

✅ **No API Required** - Runs entirely in browser
✅ **Attention Mechanism** - Computes sentence importance using embeddings
✅ **Abstractive** - Paraphrases and restructures text
✅ **Lightweight** - ~100 lines of code
✅ **Fast** - Instant summarization

## How It Works

1. **Tokenization** - Splits sentences into tokens
2. **Embeddings** - Creates normalized vector representations
3. **Attention** - Computes cross-sentence attention scores
4. **Selection** - Ranks and selects important sentences
5. **Paraphrasing** - Applies text transformations

## Commands

- `"explain briefly"` → 50 words summary
- `"explain in detail"` → 120 words summary  
- `"what is this"` → 80 words analysis

## Algorithm

```
Attention(Q,K,V) = softmax(QK^T/√d)V
- Q: Query embeddings
- K: Key embeddings  
- V: Value embeddings
- d: Embedding dimension
```

## Advantages

- No internet dependency
- Privacy-preserving (no data sent externally)
- Zero latency
- No API costs
