import com.example.api.Api.*;
import java.nio.file.Path;

public class Main {
  public static void main(String[] args) throws Exception {
    Options options = new Options().trustedCertificates(Path.of("cert.pem"));
    try (Client client = new Client("https://localhost:8443", options)) {
      TodosCreateOutput todo = client.todosCreate(new TodosCreateInput("buy milk")); // POST + Idempotency-Key
      System.out.println(todo.id() + " " + todo.title());
      try {
        client.todosCreate(new TodosCreateInput(""));
      } catch (ApueException e) {
        System.out.println(e.status() + " " + e.type()); // 400 https://michaellocher.github.io/apue/problems/validation-failed
      }
      try (Stream<TodosWatchOutput> todos = client.todosWatch()) { // closing resets the HTTP/2 stream
        for (TodosWatchOutput t : todos) System.out.println(t.title());
      }
    }
  }
}
