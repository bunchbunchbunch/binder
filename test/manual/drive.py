#!/usr/bin/env python3
"""Drive binder in a pseudo-terminal: send keys, wait for text, dump what rendered.

  python3 test/manual/drive.py [binder args...]

Steps are hard-coded below; edit them for a different scenario. Output is the
raw terminal stream with ANSI escapes stripped, so expect repeated frames.
"""
import fcntl, os, pty, re, select, struct, sys, termios, time

ANSI = re.compile(r'\x1b\[[0-9;?]*[A-Za-z]|\x1b[()][AB012]|\x1b[=>]|\x1b\][^\x07]*\x07')

def main():
    args = sys.argv[1:]
    pid, fd = pty.fork()
    if pid == 0:
        os.environ['TERM'] = 'xterm-256color'
        # The checks grep the raw output stream, which needs whole frames.
        os.environ['BINDER_FULL_REDRAW'] = '1'
        os.execvp('node', ['node', 'bin/binder.mjs'] + args)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
    buf = b''

    def read_for(seconds):
        nonlocal buf
        end = time.time() + seconds
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 0.1)
            if r:
                try:
                    chunk = os.read(fd, 65536)
                except OSError:
                    return False
                if not chunk:
                    return False
                buf += chunk
        return True

    def wait_for(pattern, timeout):
        end = time.time() + timeout
        while time.time() < end:
            if not read_for(0.2):
                break
            if re.search(pattern, ANSI.sub('', buf.decode('utf8', 'replace'))):
                return True
        return False

    def send(s):
        os.write(fd, s.encode())

    def plain():
        return ANSI.sub('', buf.decode('utf8', 'replace'))

    read_for(2)
    if os.environ.get('DRIVE_MODE') == 'resume':
        restored = bool(re.search(r'1 ● Reply with just: pong.*2 ● Now reply', plain(), re.S))
        print('tabs restored on launch:', restored)
        steps = [
            ('Which word did I ask you to repeat in caps earlier? Reply with just that word.', r'3 ● Which word', 60),
        ]
    else:
        steps = [
            ('Reply with just: pong', r'1 ● Reply with just: pong', 60),
            ('Now reply with just the word you said before, in caps.', r'2 ● Now reply', 60),
        ]
    ok = True
    mode = os.environ.get('DRIVE_MODE')
    if mode == 'ask':
        send('Use the AskUserQuestion tool to ask me which color I prefer, red or blue. Then tell me what I picked.')
        time.sleep(0.2); send('\r')
        ok = wait_for(r'Which color', 90)
        print('picker shown:', ok)
        time.sleep(0.3); send('2')
        ok = ok and wait_for(r'1 ● Use the AskUserQuestion', 90)
        print('turn finished:', ok, '| blue mentioned:', 'lue' in plain().split('1 ● Use the AskUserQuestion')[-1])
        steps = []
    if mode == 'work':
        send('Run `ls` with the Bash tool, then tell me in one sentence how many entries it listed.')
        time.sleep(0.2); send('\r')
        ok = wait_for(r'⏺ Bash', 60)
        print('tool streamed while running:', ok)
        ok = ok and wait_for(r'1 ● Run `ls`', 90)
        after = plain().split('1 ● Run `ls`')[-1]
        print('collapsed after result:', '▸ 1 tool call' in after and '⏺ Bash' not in after)
        send('\x05')  # Ctrl+E
        ok = ok and wait_for(r'▾ 1 tool call', 10)
        tail = plain()[-1500:]
        print('expanded on Ctrl+E:', '▾ 1 tool call' in tail and '⏺ Bash' in tail)
        steps = []
    if mode == 'image':
        import subprocess
        saved = subprocess.run(['pbpaste'], capture_output=True).stdout
        subprocess.run(['osascript', '-e', 'set the clipboard to (read (POSIX file "%s/fixtures/orange.png") as «class PNGf»)' % os.getcwd()], check=True)
        try:
            send('What color is this image? Reply with one word. ')
            time.sleep(0.3); send('\x16')  # Ctrl+V attaches the clipboard image
            ok = wait_for(r'\[Image #1\]', 10)
            print('placeholder inserted:', ok)
        finally:
            subprocess.run(['pbcopy'], input=saved)
        time.sleep(0.2); send('\r')
        ok = ok and wait_for(r'1 ● What color', 90)
        print('answer mentions orange:', 'range' in plain().split('1 ● What color')[-1])
        steps = []
    if mode == 'interrupt':
        send('Count from 1 to 400, one number per line, no other text.')
        time.sleep(0.2); send('\r')
        ok = wait_for(r'1 [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Count', 30)
        time.sleep(3); send('\x1b')
        ok = ok and wait_for(r'1 ◼ Count', 30)
        print('interrupted tab:', ok)
        steps = [('Reply with just: alive', r'2 ● Reply with just: alive', 60)]
    for prompt, expect, timeout in steps:
        send(prompt)
        time.sleep(0.2)
        send('\r')
        if not wait_for(expect, timeout):
            print(f'TIMEOUT waiting for {expect!r}')
            ok = False
            break
        print(f'OK: {expect!r}')
    read_for(2)
    text = plain()
    print('--- last 2500 chars ---')
    print(text[-2500:])
    print('--- checks ---')
    print('pong in output:', 'pong' in text)
    print('PONG in output:', 'PONG' in text)
    print('usage % shown:', bool(re.search(r'\d+%', text)))
    send('\x03'); time.sleep(0.3); send('\x03')
    read_for(3)
    tail = plain()[-400:]
    print('--- exit tail ---')
    print(tail)
    m = re.search(r'Resume with: binder ([0-9a-f-]{36})', plain())
    print('session:', m.group(1) if m else None)
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
    sys.exit(0 if ok and m else 1)

if __name__ == '__main__':
    main()
