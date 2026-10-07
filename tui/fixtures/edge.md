# Heading with `code` and **bold** inside

Text with a very long URL https://example.com/a/very/long/path/that/keeps/going/and/going/with/query?param=value&other=thing#fragment-at-the-end and a bare autolink <https://autolink.test>. Emoji widths 🎉 👩‍💻 ✅ and CJK 日本語テキスト should align.

5. Numbered list that starts at five
6. Second item with a code block below it:

   ```json
   {"type": "result", "num_turns": 1}
   ```

7. Third item
   with a lazy continuation line
   - nested bullet
     1. deeply nested ordered
     2. another one

- Loose list item one

- Loose list item two with a paragraph

  Second paragraph in the item.

| Column | A much longer header that will need to shrink | Short | Another column with text that is quite long and must wrap inside its cell | N |
|---|---|---|---|---:|
| a | `code in a cell` and **bold** | x | The quick brown fox jumps over the lazy dog, then does it again for good measure | 1 |
| b | plain | y | short | 1000 |

Line one with a hard break  
line two after the break.

```
no language given
	tab indented line
```

<div align="center">raw html block</div>

Some_text_with_underscores and 2*3*4 math, plus an escaped \*asterisk\*.

Inline `code with a backtick ``inside`` it`.

## Streaming cut-off below

```python
def partial(x):
    return x +
