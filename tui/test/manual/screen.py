#!/usr/bin/env python3
"""Run binder in a pty, send one prompt, and dump the final screen as HTML.

  <venv>/bin/python test/manual/screen.py "prompt text" out.html [binder args...]

Needs `pyte` (pip install pyte). The screen is emulated at 110x45 so Ink's
alternate-screen redraws resolve to one final frame, including colors.
"""
import fcntl, html, os, pty, re, select, struct, sys, termios, time
import pyte

COLS, ROWS = 110, 45

def main():
    prompt, out_path, *args = sys.argv[1:]
    pid, fd = pty.fork()
    if pid == 0:
        os.environ['TERM'] = 'xterm-256color'
        os.execvp('node', ['node', 'bin/binder.mjs'] + args)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', ROWS, COLS, 0, 0))
    screen = pyte.Screen(COLS, ROWS)
    stream = pyte.ByteStream(screen)

    def pump(seconds):
        end = time.time() + seconds
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 0.1)
            if r:
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    return False
                if not data:
                    return False
                stream.feed(data)
        return True

    def text():
        return '\n'.join(screen.display)

    pump(2)
    os.write(fd, prompt.encode()); time.sleep(0.2); os.write(fd, b'\r')
    deadline = time.time() + 120
    while time.time() < deadline:
        pump(0.5)
        if re.search(r'1 [●✗◼] ', text()):
            break
    pump(1.5)
    os.write(fd, b'\x03'); time.sleep(0.3); os.write(fd, b'\x03')
    pump(2)
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass

    # Final frame (pyte keeps the last screen even after the alternate screen is left? It
    # does not restore, so grab the buffer before exit would be better; we re-render from
    # the saved snapshot taken right after the turn finished).
    write_html(snapshot, out_path)

def write_html(rows, path):
    def color(c, default):
        if c == 'default': return default
        if re.fullmatch(r'[0-9a-f]{6}', c): return '#' + c
        named = {'black':'#000','red':'#cd3131','green':'#0dbc79','brown':'#e5e510','blue':'#2472c8','magenta':'#bc3fbc','cyan':'#11a8cd','white':'#e5e5e5',
                 'brightblack':'#666','brightred':'#f14c4c','brightgreen':'#23d18b','brightbrown':'#f5f543','brightblue':'#3b8eea','brightmagenta':'#d670d6','brightcyan':'#29b8db','brightwhite':'#fff'}
        return named.get(c, default)
    out = []
    for row in rows:
        line = ''
        for ch in row:
            css = [f'color:{color(ch.fg, "#c0caf5")}', f'background:{color(ch.bg, "transparent")}']
            if ch.bold: css.append('font-weight:bold')
            if ch.italics: css.append('font-style:italic')
            deco = ' '.join(d for d, on in (('underline', ch.underscore), ('line-through', ch.strikethrough)) if on)
            if deco: css.append(f'text-decoration:{deco}')
            if ch.reverse: css.append('filter:invert(1)')
            line += f'<span style="{";".join(css)}">{html.escape(ch.data or " ")}</span>'
        out.append(line)
    with open(path, 'w') as f:
        f.write('<!doctype html><meta charset="utf-8"><body style="margin:0;background:#1a1b26;padding:12px">'
                f'<pre style="margin:0;font:14px/1.3 \'Hack Nerd Font\',Menlo,monospace">{chr(10).join(out)}</pre></body>')

snapshot = None

if __name__ == '__main__':
    # Capture the snapshot inside main via a small shim: monkeypatch pump to save rows.
    _main = main
    def main():  # noqa: F811
        global snapshot
        import types
        # Re-implement with snapshot capture to keep the file simple.
        prompt, out_path, *args = sys.argv[1:]
        pid, fd = pty.fork()
        if pid == 0:
            os.environ['TERM'] = 'xterm-256color'
            os.execvp('node', ['node', 'bin/binder.mjs'] + args)
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', ROWS, COLS, 0, 0))
        screen = pyte.Screen(COLS, ROWS)
        stream = pyte.ByteStream(screen)
        def pump(seconds):
            end = time.time() + seconds
            while time.time() < end:
                r, _, _ = select.select([fd], [], [], 0.1)
                if r:
                    try:
                        data = os.read(fd, 65536)
                    except OSError:
                        return False
                    if not data:
                        return False
                    stream.feed(data)
            return True
        pump(2)
        os.write(fd, prompt.encode()); time.sleep(0.2); os.write(fd, b'\r')
        deadline = time.time() + 150
        while time.time() < deadline:
            pump(0.5)
            if re.search(r'1 [●✗◼] ', '\n'.join(screen.display)):
                break
        pump(1.5)
        if os.environ.get('SCREEN_KEYS'):
            for key in os.environ['SCREEN_KEYS'].split(','):
                os.write(fd, bytes.fromhex(key)); pump(0.6)
        snapshot = [[screen.buffer[y][x] for x in range(COLS)] for y in range(ROWS)]
        print('\n'.join(screen.display))
        os.write(fd, b'\x03'); time.sleep(0.3); os.write(fd, b'\x03')
        pump(2)
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass
        write_html(snapshot, out_path)
    main()
