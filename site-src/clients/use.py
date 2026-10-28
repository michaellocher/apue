from api import ApueError, Client

with Client("https://localhost:8443", cafile="cert.pem") as client:
    todo = client.todos_create({"title": "buy milk"})  # POST + Idempotency-Key, retried safely
    print(len(client.todos_list()))                    # GET /todos.list?i=…
    try:
        client.todos_create({"title": ""})             # validated before it is sent
    except ApueError as e:
        print(e.status, e.type)                        # 400 https://apue.dev/problems/validation-failed
    for t in client.todos_watch():                     # resumes after a lost connection
        print(t["title"])
